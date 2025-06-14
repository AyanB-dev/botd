/**
 * Daily Task Limit Manager and Voice Stats Reset Manager
 * Handles 10 tasks per day limit, midnight cleanup, and daily voice stats reset
 */

const { pool, executeWithResilience } = require('../models/db');
const { measureDatabase } = require('./performanceMonitor');
const CacheInvalidationService = require('./cacheInvalidationService');
const dayjs = require('dayjs');

class DailyTaskManager {
    constructor() {
        this.DAILY_TASK_LIMIT = 10;
        this.cleanupInterval = null;
        this.isRunning = false;
        this.discordClient = null;
    }

    /**
     * Set Discord client reference for notifications
     */
    setDiscordClient(client) {
        this.discordClient = client;
        console.log('✅ Discord client reference set for DailyTaskManager');
    }

    /**
     * Start the daily cleanup scheduler
     */
    start() {
        if (this.isRunning) {
            console.log('🕛 Daily task manager is already running');
            return;
        }

        // Check every minute for cleanup (23:59)
        this.cleanupInterval = setInterval(async() => {
            await this.checkMidnightCleanup();
        }, 60 * 1000); // Every minute

        this.isRunning = true;
        console.log('🕛 Daily task manager started - monitoring for midnight cleanup');
    }

    /**
     * Stop the scheduler
     */
    stop() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
        this.isRunning = false;
        console.log('🕛 Daily task manager stopped');
    }

    /**
     * Check if it's time for midnight cleanup and daily voice stats reset (00:00)
     */
    async checkMidnightCleanup() {
        const now = dayjs();

        // Run cleanup at 00:00 (midnight - start of new day)
        if (now.hour() === 0 && now.minute() === 0) {
            console.log('🌅 Starting midnight cleanup and daily voice stats reset...');
            await this.performMidnightOperations();
        }
    }

    /**
     * Perform midnight operations - reset daily voice stats, delete pending tasks, and notify users
     */
    async performMidnightOperations() {
        const client = await pool.connect();

        try {
            // Step 1: Handle users currently in voice channels during daily reset
            await this.handleActiveVoiceSessionsAtMidnight();

            // Step 2: Reset daily voice stats for all users (new day = fresh daily limits)
            await this.resetDailyVoiceStats();

            // Step 3: Get all users with pending tasks for cleanup
            const usersWithTasks = await client.query(`
                SELECT DISTINCT discord_id,
                    COUNT(*) as pending_count,
                    ARRAY_AGG(title ORDER BY created_at) as pending_titles
                FROM tasks
                WHERE is_complete = FALSE
                GROUP BY discord_id
            `);

            console.log(`🧹 Found ${usersWithTasks.rows.length} users with pending tasks to clean up`);

            // Step 4: Process each user's task cleanup
            for (const user of usersWithTasks.rows) {
                try {
                    await this.cleanupUserTasks(user.discord_id, user.pending_count, user.pending_titles);
                } catch (error) {
                    console.error(`❌ Error cleaning up tasks for user ${user.discord_id}:`, error);
                }
            }

            // Step 5: Reset daily task stats for all users (new day = new task limits)
            await client.query(`
                UPDATE daily_task_stats
                SET tasks_added = 0, tasks_completed = 0, total_task_actions = 0
                WHERE date < CURRENT_DATE
            `);

            console.log('✅ Midnight operations completed successfully - daily voice stats reset and task cleanup done');

        } catch (error) {
            console.error('❌ Error during midnight operations:', error);
        } finally {
            client.release();
        }
    }

    /**
     * Handle users who are currently in voice channels during daily reset
     * INTEGRATED WITH ENHANCED MIDNIGHT RESET SYSTEM
     */
    async handleActiveVoiceSessionsAtMidnight() {
        try {
            // Get reference to active voice sessions from voiceStateUpdate
            const { activeVoiceSessions, gracePeriodSessions } = require('../events/voiceStateUpdate');

            const totalActiveUsers = activeVoiceSessions.size + gracePeriodSessions.size;

            if (totalActiveUsers === 0) {
                console.log('📊 No active voice sessions during daily reset');
                return { processedSessions: 0, gracePeriodHandled: 0 };
            }

            console.log(`📊 Handling ${totalActiveUsers} voice users during daily reset (${activeVoiceSessions.size} active, ${gracePeriodSessions.size} grace period)...`);

            // The actual processing is now handled by resetDailyVoiceStats()
            // which calls processUserMidnightReset() for each user
            // This provides better coordination and error handling

            const resetResults = await this.resetDailyVoiceStats();

            console.log('✅ All voice session processing completed during daily reset');
            return resetResults;

        } catch (error) {
            console.error('❌ Error handling active voice sessions at midnight:', error);
            return { processedSessions: 0, gracePeriodHandled: 0, errors: 1 };
        }
    }

    /**
     * Enhanced Midnight Reset System - Handles all voice users during 00:00 reset
     * FULLY COMPATIBLE WITH: Daily Cumulative Points, Grace Period, 55-Min Rounding, Task Integration
     */
    async resetDailyVoiceStats() {
        return executeWithResilience(async(client) => {
            console.log('🌅 Starting comprehensive midnight reset system...');

            // Get reference to active voice sessions and grace period sessions
            const { activeVoiceSessions, gracePeriodSessions } = require('../events/voiceStateUpdate');
            const voiceService = require('../services/voiceService');

            const allActiveUsers = new Set([
                ...Array.from(activeVoiceSessions.keys()),
                ...Array.from(gracePeriodSessions.keys())
            ]);

            console.log(`📊 Processing midnight reset for ${allActiveUsers.size} users (${activeVoiceSessions.size} active, ${gracePeriodSessions.size} grace period)`);

            // Step 1: Handle all users currently in voice or grace period
            const resetResults = {
                processedSessions: 0,
                gracePeriodHandled: 0,
                newSessionsCreated: 0,
                errors: 0,
                totalPointsAwarded: 0,
                totalHoursProcessed: 0
            };

            for (const userId of allActiveUsers) {
                try {
                    const result = await this.processUserMidnightReset(userId, activeVoiceSessions, gracePeriodSessions, voiceService);

                    resetResults.processedSessions++;
                    if (result.wasInGracePeriod) resetResults.gracePeriodHandled++;
                    if (result.newSessionCreated) resetResults.newSessionsCreated++;
                    resetResults.totalPointsAwarded += result.pointsAwarded || 0;
                    resetResults.totalHoursProcessed += result.hoursProcessed || 0;

                } catch (error) {
                    console.error(`❌ Error processing midnight reset for user ${userId}:`, error);
                    resetResults.errors++;
                }
            }

            // Step 2: Archive completed daily stats for users not in voice
            const yesterday = require('dayjs')().subtract(1, 'day').format('YYYY-MM-DD');
            const usersInVoiceArray = Array.from(allActiveUsers);

            let archiveQuery = `
                UPDATE daily_voice_stats
                SET archived = true, updated_at = CURRENT_TIMESTAMP
                WHERE date = $1`;

            const queryParams = [yesterday];

            if (usersInVoiceArray.length > 0) {
                const placeholders = usersInVoiceArray.map((_, i) => `$${i + 2}`).join(',');
                archiveQuery += ` AND discord_id NOT IN (${placeholders})`;
                queryParams.push(...usersInVoiceArray);
            }

            const archiveResult = await client.query(archiveQuery, queryParams);
            console.log(`📊 Archived ${archiveResult.rowCount} completed daily stats from yesterday`);

            // Step 3: Clear voice-related caches to ensure fresh data for new day
            const queryCache = require('./queryCache');
            queryCache.invalidatePattern('user_stats*');
            queryCache.invalidatePattern('daily_voice*');
            queryCache.invalidatePattern('leaderboard*');

            // Step 4: Log comprehensive reset summary
            console.log('✅ Enhanced midnight reset completed successfully!');
            console.log('═'.repeat(50));
            console.log('📊 MIDNIGHT RESET SUMMARY:');
            console.log(`   👥 Users Processed: ${resetResults.processedSessions}`);
            console.log(`   🔄 Grace Period Handled: ${resetResults.gracePeriodHandled}`);
            console.log(`   🆕 New Sessions Created: ${resetResults.newSessionsCreated}`);
            console.log(`   💰 Total Points Awarded: ${resetResults.totalPointsAwarded}`);
            console.log(`   ⏰ Total Hours Processed: ${resetResults.totalHoursProcessed.toFixed(2)}h`);
            console.log(`   📁 Daily Stats Archived: ${archiveResult.rowCount}`);
            console.log(`   ❌ Errors: ${resetResults.errors}`);
            console.log('═'.repeat(50));

            return resetResults;
        });
    }

    /**
     * Process individual user's midnight reset - handles all edge cases
     */
    async processUserMidnightReset(userId, activeVoiceSessions, gracePeriodSessions, voiceService) {
        const result = {
            wasInGracePeriod: false,
            newSessionCreated: false,
            pointsAwarded: 0,
            hoursProcessed: 0,
            sessionType: 'none'
        };

        // Determine user's current state
        const isInActiveVoice = activeVoiceSessions.has(userId);
        const isInGracePeriod = gracePeriodSessions.has(userId);

        if (isInGracePeriod) {
            result.wasInGracePeriod = true;
            result.sessionType = 'grace_period';

            // Handle grace period user during midnight reset
            const gracePeriodData = gracePeriodSessions.get(userId);
            console.log(`⏸️ Processing grace period user ${userId} during midnight reset`);

            // End their previous session with midnight crossover
            const crossoverResult = await voiceService.handleMidnightCrossover(
                userId,
                gracePeriodData.channelId,
                null // No member object during automated reset
            );

            if (crossoverResult) {
                result.pointsAwarded = crossoverResult.yesterdaySession?.points_earned || 0;
                result.hoursProcessed = (crossoverResult.yesterdaySession?.duration_minutes || 0) / 60;

                // Remove from grace period - they're considered disconnected for new day
                gracePeriodSessions.delete(userId);
                activeVoiceSessions.delete(userId);

                console.log(`✅ Grace period user ${userId} processed: ${result.hoursProcessed.toFixed(2)}h, ${result.pointsAwarded} points`);
            }

        } else if (isInActiveVoice) {
            result.sessionType = 'active_voice';

            // Handle active voice user during midnight reset
            const sessionData = activeVoiceSessions.get(userId);
            console.log(`🎤 Processing active voice user ${userId} during midnight reset`);

            // Use midnight crossover to split sessions properly
            const crossoverResult = await voiceService.handleMidnightCrossover(
                userId,
                sessionData.channelId,
                null // No member object during automated reset
            );

            if (crossoverResult && crossoverResult.todaySession) {
                result.pointsAwarded = crossoverResult.yesterdaySession?.points_earned || 0;
                result.hoursProcessed = (crossoverResult.yesterdaySession?.duration_minutes || 0) / 60;
                result.newSessionCreated = true;

                // Update active session tracking with new session data
                activeVoiceSessions.set(userId, {
                    channelId: sessionData.channelId,
                    joinTime: new Date(), // Fresh start at midnight
                    sessionId: crossoverResult.todaySession.id,
                    lastSeen: new Date()
                });

                console.log(`✅ Active voice user ${userId} processed: ${result.hoursProcessed.toFixed(2)}h, ${result.pointsAwarded} points, new session started`);
            }
        }

        return result;
    }

    /**
     * Perform midnight cleanup - delete all pending tasks and notify users (legacy method for task cleanup only)
     */
    async performMidnightCleanup() {
        const client = await pool.connect();

        try {
            // Get all users with pending tasks
            const usersWithTasks = await client.query(`
                SELECT DISTINCT discord_id,
                    COUNT(*) as pending_count,
                    ARRAY_AGG(title ORDER BY created_at) as pending_titles
                FROM tasks
                WHERE is_complete = FALSE
                GROUP BY discord_id
            `);

            console.log(`🧹 Found ${usersWithTasks.rows.length} users with pending tasks to clean up`);

            // Process each user
            for (const user of usersWithTasks.rows) {
                try {
                    await this.cleanupUserTasks(user.discord_id, user.pending_count, user.pending_titles);
                } catch (error) {
                    console.error(`❌ Error cleaning up tasks for user ${user.discord_id}:`, error);
                }
            }

            // Reset daily task stats for all users (new day = new limits)
            await client.query(`
                UPDATE daily_task_stats
                SET tasks_added = 0, tasks_completed = 0, total_task_actions = 0
                WHERE date < CURRENT_DATE
            `);

            console.log('✅ Midnight task cleanup completed successfully');

        } catch (error) {
            console.error('❌ Error during midnight cleanup:', error);
        } finally {
            client.release();
        }
    }

    /**
     * Clean up tasks for a specific user and send notification
     */
    async cleanupUserTasks(discordId, taskCount, taskTitles) {
        return executeWithResilience(async(client) => {
            // Delete all pending tasks for this user
            await client.query(
                'DELETE FROM tasks WHERE discord_id = $1 AND is_complete = FALSE',
                [discordId]
            );

            // Clear user cache
            CacheInvalidationService.invalidateAfterTaskOperation(discordId);

            // Try to send notification to user
            await this.sendCleanupNotification(discordId, taskCount, taskTitles);

            console.log(`🧹 Cleaned up ${taskCount} pending tasks for user ${discordId}`);
        });
    }

    /**
     * Send cleanup notification to user via DM
     */
    async sendCleanupNotification(discordId, taskCount, taskTitles) {
        try {
            // Use stored Discord client reference
            if (!this.discordClient) {
                console.log(`⚠️ No Discord client available for notification to ${discordId}`);
                return;
            }

            const user = await this.discordClient.users.fetch(discordId);
            if (!user) return;

            const taskList = taskTitles.slice(0, 5).map((title, index) => `${index + 1}. ${title}`).join('\n');
            const moreTasksText = taskTitles.length > 5 ? `\n... and ${taskTitles.length - 5} more tasks` : '';

            const notificationMessage = `🌅 **Daily Task Reset Complete!**

**${taskCount} pending tasks** have been cleared from your list:

\`\`\`
${taskList}${moreTasksText}
\`\`\`

✨ **Fresh Start:** You now have a clean slate with **10 new task slots** for today!

💡 **Tips for Tomorrow:**
• Add tasks you can realistically complete
• Complete tasks as you finish them to earn points
• Stay in voice channels 20+ minutes to complete tasks

Ready to boost your productivity? Use \`/addtask\` to get started! 🚀`;

            await user.send(notificationMessage);
            console.log(`📧 Sent cleanup notification to user ${discordId}`);

        } catch (error) {
            console.log(`⚠️ Could not send cleanup notification to ${discordId}: ${error.message}`);
        }
    }

    /**
     * Check if user can add more tasks today
     */
    async canUserAddTask(discordId) {
        return measureDatabase('checkDailyTaskLimit', async() => {
            return executeWithResilience(async(client) => {
                const today = dayjs().format('YYYY-MM-DD');

                // Get today's task stats
                const result = await client.query(
                    'SELECT total_task_actions FROM daily_task_stats WHERE discord_id = $1 AND date = $2',
                    [discordId, today]
                );

                const currentActions = result.rows[0]?.total_task_actions || 0;
                const remaining = Math.max(0, this.DAILY_TASK_LIMIT - currentActions);

                return {
                    canAdd: currentActions < this.DAILY_TASK_LIMIT,
                    currentActions,
                    remaining,
                    limit: this.DAILY_TASK_LIMIT
                };
            });
        })();
    }

    /**
     * Check if user can complete more tasks today
     */
    async canUserCompleteTask(discordId) {
        return await this.canUserAddTask(discordId); // Same logic for both
    }

    /**
     * Record a task action (add or complete)
     */
    async recordTaskAction(discordId, actionType) {
        return measureDatabase('recordTaskAction', async() => {
            return executeWithResilience(async(client) => {
                const today = dayjs().format('YYYY-MM-DD');

                // Ensure user exists
                await client.query(
                    `INSERT INTO users (discord_id, username)
                     VALUES ($1, $1)
                     ON CONFLICT (discord_id) DO NOTHING`,
                    [discordId]
                );

                // Update or create daily task stats
                const incrementField = actionType === 'add' ? 'tasks_added' : 'tasks_completed';

                await client.query(`
                    INSERT INTO daily_task_stats (user_id, discord_id, date, ${incrementField}, total_task_actions)
                    VALUES ((SELECT id FROM users WHERE discord_id = $1), $1, $2, 1, 1)
                    ON CONFLICT (discord_id, date)
                    DO UPDATE SET
                        ${incrementField} = daily_task_stats.${incrementField} + 1,
                        total_task_actions = daily_task_stats.total_task_actions + 1,
                        updated_at = CURRENT_TIMESTAMP
                `, [discordId, today]);

                // Clear cache for this user
                CacheInvalidationService.invalidateAfterTaskOperation(discordId);
            });
        })();
    }

    /**
     * Get user's daily task stats
     */
    async getUserDailyStats(discordId) {
        return measureDatabase('getUserDailyTaskStats', async() => {
            return executeWithResilience(async(client) => {
                const today = dayjs().format('YYYY-MM-DD');

                const result = await client.query(
                    `SELECT tasks_added, tasks_completed, total_task_actions
                     FROM daily_task_stats
                     WHERE discord_id = $1 AND date = $2`,
                    [discordId, today]
                );

                const stats = result.rows[0] || { tasks_added: 0, tasks_completed: 0, total_task_actions: 0 };
                const remaining = Math.max(0, this.DAILY_TASK_LIMIT - stats.total_task_actions);

                return {
                    ...stats,
                    remaining,
                    limit: this.DAILY_TASK_LIMIT,
                    limitReached: stats.total_task_actions >= this.DAILY_TASK_LIMIT
                };
            });
        })();
    }

    /**
     * Get scheduler status
     */
    getStatus() {
        return {
            isRunning: this.isRunning,
            dailyLimit: this.DAILY_TASK_LIMIT,
            nextCleanup: this.isRunning ? 'Daily at 00:00 (task cleanup + voice stats reset)' : 'Not scheduled'
        };
    }

    /**
     * Manual trigger cleanup (admin function)
     */
    async forceCleanup() {
        console.log('🧹 Force triggering midnight cleanup...');
        await this.performMidnightCleanup();
    }

    /**
     * Regain a task slot when removing a task (only for tasks added today)
     */
    async reclaimTaskSlot(discordId, taskCreatedAt) {
        return measureDatabase('reclaimTaskSlot', async() => {
            return executeWithResilience(async(client) => {
                const today = dayjs().format('YYYY-MM-DD');
                const taskDate = dayjs(taskCreatedAt).format('YYYY-MM-DD');

                // Only regain slot if task was created today
                if (taskDate !== today) {
                    return {
                        slotReclaimed: false,
                        reason: 'Task was created on a different day'
                    };
                }

                // Check if user has daily stats for today
                const result = await client.query(
                    'SELECT tasks_added, tasks_completed, total_task_actions FROM daily_task_stats WHERE discord_id = $1 AND date = $2',
                    [discordId, today]
                );

                if (result.rows.length === 0 || result.rows[0].tasks_added === 0) {
                    return {
                        slotReclaimed: false,
                        reason: 'No task additions recorded for today'
                    };
                }

                const stats = result.rows[0];
                const tasksCompleted = stats.tasks_completed;
                const currentTotalActions = stats.total_task_actions;

                // Calculate maximum recoverable slots = DAILY_LIMIT - tasks_completed
                // This ensures users can't exceed their theoretical maximum after completing tasks
                const maxRecoverableSlots = this.DAILY_TASK_LIMIT - tasksCompleted;
                const currentAvailableSlots = this.DAILY_TASK_LIMIT - currentTotalActions;

                // Check if user would exceed their recoverable limit
                const newTotalActions = currentTotalActions - 1;
                const newAvailableSlots = this.DAILY_TASK_LIMIT - newTotalActions;

                if (newAvailableSlots > maxRecoverableSlots) {
                    return {
                        slotReclaimed: false,
                        reason: `Cannot reclaim slot: Maximum recoverable slots is ${maxRecoverableSlots} (you've completed ${tasksCompleted} tasks today)`,
                        maxRecoverableSlots,
                        tasksCompleted,
                        currentAvailableSlots
                    };
                }

                // Decrease the task counts (only if within recoverable limit)
                await client.query(`
                    UPDATE daily_task_stats
                    SET tasks_added = GREATEST(0, tasks_added - 1),
                        total_task_actions = GREATEST(0, total_task_actions - 1),
                        updated_at = CURRENT_TIMESTAMP
                    WHERE discord_id = $1 AND date = $2
                `, [discordId, today]);

                // Clear cache for this user
                CacheInvalidationService.invalidateAfterTaskOperation(discordId);

                return {
                    slotReclaimed: true,
                    reason: 'Task slot successfully reclaimed',
                    maxRecoverableSlots,
                    tasksCompleted,
                    newAvailableSlots
                };
            });
        })();
    }
}

module.exports = DailyTaskManager;
