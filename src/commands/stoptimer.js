const { SlashCommandBuilder } = require('discord.js');
const { getUserVoiceChannel } = require('../utils/voiceUtils');
const { createSuccessTemplate, createErrorTemplate } = require('../utils/embedTemplates');
const { StatusEmojis } = require('../utils/constants');
const { safeDeferReply, safeErrorReply, safeReply } = require('../utils/interactionUtils');
const timezoneService = require('../services/timezoneService');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

// Extend dayjs with timezone support
dayjs.extend(utc);
dayjs.extend(timezone);

module.exports = {
    data: new SlashCommandBuilder()
        .setName('stoptimer')
        .setDescription('Stop the active Pomodoro timer in your voice channel'),
    async execute(interaction, { activeVoiceTimers }) {
        try {
            // Immediately defer to prevent timeout
            const deferred = await safeDeferReply(interaction);
            if (!deferred) {
                console.warn('Failed to defer stoptimer interaction');
                return;
            }

            // Use the reliable voice channel detection utility
            const voiceChannel = await getUserVoiceChannel(interaction);

            if (!voiceChannel) {
                const embed = createErrorTemplate(
                    `${StatusEmojis.ERROR} Voice Channel Required`,
                    'You must be in a voice channel to stop a timer and manage your productivity sessions.',
                    {
                        helpText: `${StatusEmojis.INFO} Join the voice channel with an active timer`,
                        additionalInfo: 'Timer controls are tied to your current voice channel location.'
                    }
                );
                return safeReply(interaction, { embeds: [embed] });
            }

            const voiceChannelId = voiceChannel.id;
            if (!activeVoiceTimers.has(voiceChannelId)) {
                const embed = createErrorTemplate(
                    `${StatusEmojis.WARNING} No Active Timer Found`,
                    `No Pomodoro timer is currently running in <#${voiceChannelId}>. There's nothing to stop!`,
                    {
                        helpText: `${StatusEmojis.INFO} Use \`/timer <work_minutes>\` to start a new Pomodoro session`,
                        additionalInfo: 'Check `/time` to see if there are any active timers in your current voice channel.'
                    }
                );
                return interaction.reply({ embeds: [embed] });
            }
            const timer = activeVoiceTimers.get(voiceChannelId);
            if (timer.workTimeout) clearTimeout(timer.workTimeout);
            if (timer.breakTimeout) clearTimeout(timer.breakTimeout);
            activeVoiceTimers.delete(voiceChannelId);

            const embed = createSuccessTemplate(
                `${StatusEmojis.COMPLETED} Timer Stopped Successfully`,
                `Your Pomodoro timer in <#${voiceChannelId}> has been stopped. ${StatusEmojis.READY} No worries - every session counts towards building your productivity habits!`,
                {
                    helpText: `${StatusEmojis.INFO} Use \`/timer <work_minutes>\` when you're ready for another session`,
                    additionalInfo: 'Remember: Consistency is key to building productive habits.'
                }
            );

            // Add timezone context showing when timer was stopped
            try {
                const userTimezone = await timezoneService.getUserTimezone(interaction.user.id);
                const stopTime = dayjs().tz(userTimezone);
                const timerFooter = `🌍 Timer stopped at: ${stopTime.format('h:mm A')} (${userTimezone}) | Use /timer to start a new session`;

                embed.setFooter({ text: timerFooter });
            } catch (error) {
                console.warn('Could not add timezone info to timer stop:', error.message);
                embed.setFooter({ text: 'Use /timer to start a new session when ready' });
            }

            return interaction.editReply({ embeds: [embed] });
        } catch (error) {
            console.error('Error in /stoptimer:', error);

            const embed = createErrorTemplate(
                `${StatusEmojis.ERROR} Timer Stop Failed`,
                'An error occurred while stopping your timer. Please try again in a moment.',
                { helpText: `${StatusEmojis.INFO} If this problem persists, contact support` }
            );

            await safeErrorReply(interaction, embed);
        }
    }
};
