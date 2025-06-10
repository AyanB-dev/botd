/**
 * Cache warming strategy for improved performance
 * Proactively loads frequently accessed data into cache
 */

const queryCache = require('./queryCache');
const voiceService = require('../services/voiceService');

class CacheWarming {
    constructor() {
        this.isWarming = false;
        this.lastWarmTime = null;
        this.warmingInterval = null;
    }

    /**
     * Start automated cache warming (run on bot startup and periodically)
     */
    async startCacheWarming() {
        if (this.isWarming) {
            console.log('🔥 Cache warming already in progress');
            return;
        }

        console.log('🔥 Starting cache warming strategy...');
        await this.performWarmUp();

        // Set up periodic warming every 30 minutes
        this.warmingInterval = setInterval(async () => {
            try {
                await this.performWarmUp();
            } catch (error) {
                console.error('❌ Error in periodic cache warming:', error);
            }
        }, 30 * 60 * 1000); // 30 minutes

        console.log('✅ Cache warming strategy activated');
    }

    /**
     * Stop automated cache warming
     */
    stopCacheWarming() {
        if (this.warmingInterval) {
            clearInterval(this.warmingInterval);
            this.warmingInterval = null;
            console.log('🛑 Cache warming stopped');
        }
    }

    /**
     * Perform cache warm-up for frequently accessed data
     */
    async performWarmUp() {
        if (this.isWarming) return;

        this.isWarming = true;
        const startTime = Date.now();
        let warmedEntries = 0;

        try {
            console.log('🔥 Warming cache with frequently accessed data...');

            // 1. Warm leaderboard data (accessed by many users)
            const leaderboardData = [
                { type: 'monthly', key: 'leaderboard:monthly' },
                { type: 'alltime', key: 'leaderboard:alltime' }
            ];

            for (const { type, key } of leaderboardData) {
                if (!queryCache.get(key)) {
                    try {
                        const data = await voiceService.getLeaderboard(type);
                        if (data && data.length > 0) {
                            queryCache.set(key, data, 'leaderboard');
                            warmedEntries++;
                            console.log(`   🎯 Warmed ${type} leaderboard (${data.length} entries)`);
                        }
                    } catch (error) {
                        console.warn(`   ⚠️ Failed to warm ${type} leaderboard:`, error.message);
                    }
                }
            }

            // 2. Warm house leaderboard data
            const houseData = [
                { type: 'monthly', key: 'house_leaderboard:monthly' },
                { type: 'alltime', key: 'house_leaderboard:alltime' }
            ];

            for (const { type, key } of houseData) {
                if (!queryCache.get(key)) {
                    try {
                        const data = await voiceService.getHouseLeaderboard(type);
                        if (data && data.length > 0) {
                            queryCache.set(key, data, 'houseLeaderboard');
                            warmedEntries++;
                            console.log(`   🏠 Warmed ${type} house leaderboard (${data.length} houses)`);
                        }
                    } catch (error) {
                        console.warn(`   ⚠️ Failed to warm ${type} house leaderboard:`, error.message);
                    }
                }
            }

            // 3. Warm house champions data
            const championData = [
                { type: 'monthly', key: 'house_champions:monthly' },
                { type: 'alltime', key: 'house_champions:alltime' }
            ];

            for (const { type, key } of championData) {
                if (!queryCache.get(key)) {
                    try {
                        const data = await voiceService.getHouseChampions(type);
                        if (data && data.length > 0) {
                            queryCache.set(key, data, 'houseChampions');
                            warmedEntries++;
                            console.log(`   👑 Warmed ${type} house champions (${data.length} champions)`);
                        }
                    } catch (error) {
                        console.warn(`   ⚠️ Failed to warm ${type} house champions:`, error.message);
                    }
                }
            }

            // 4. Use batch cache operations for efficiency
            const batchEntries = [];

            // Add any additional static data that should be cached
            // (This section can be expanded based on usage patterns)

            if (batchEntries.length > 0) {
                await queryCache.batchSet(batchEntries);
                warmedEntries += batchEntries.length;
                console.log(`   📦 Batch warmed ${batchEntries.length} additional entries`);
            }

            const duration = Date.now() - startTime;
            this.lastWarmTime = new Date();

            console.log(`🔥 Cache warming completed: ${warmedEntries} entries warmed in ${duration}ms`);

        } catch (error) {
            console.error('❌ Cache warming failed:', error);
        } finally {
            this.isWarming = false;
        }
    }

    /**
     * Get cache warming status
     */
    getStatus() {
        return {
            isActive: !!this.warmingInterval,
            isCurrentlyWarming: this.isWarming,
            lastWarmTime: this.lastWarmTime,
            nextWarmIn: this.warmingInterval ? 'Within 30 minutes' : 'Not scheduled'
        };
    }

    /**
     * Smart cache warming based on usage patterns
     */
    async warmUserRelatedData(discordId) {
        try {
            // This method can be called when a user joins to pre-warm their data
            const userStatsKey = `user_stats:${discordId}`;
            const userTasksKey = `user_tasks:${discordId}`;

            if (!queryCache.get(userStatsKey)) {
                // Pre-load user stats if not cached
                const voiceService = require('../services/voiceService');
                await voiceService.getUserStats(discordId);
                console.log(`🔥 Pre-warmed user stats for ${discordId}`);
            }

            if (!queryCache.get(userTasksKey)) {
                // Pre-load user tasks if not cached
                const taskService = require('../services/taskService');
                await taskService.getUserTasks(discordId);
                console.log(`🔥 Pre-warmed user tasks for ${discordId}`);
            }
        } catch (error) {
            console.warn(`⚠️ Failed to warm user data for ${discordId}:`, error.message);
        }
    }
}

module.exports = new CacheWarming();
