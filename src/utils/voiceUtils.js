/**
 * Reliably get the voice channel for a user from an interaction
 * This function handles the case where Discord's cached member data might be stale
 * @param {ChatInputCommandInteraction} interaction - The Discord interaction
 * @param {Object} options - Options for voice channel detection
 * @returns {Promise<VoiceChannel|null>} - The voice channel or null if not found
 */
async function getUserVoiceChannel(interaction, options = {}) {
    const { useForceFetch = false, timeout = 3000 } = options;

    try {
        if (!interaction.guild) {
            console.warn('No guild found in interaction');
            return null;
        }

        // Method 1: Try cached member data first (fastest)
        if (interaction.member?.voice?.channel) {
            console.log(`Voice channel found via cached member: ${interaction.member.voice.channel.name} (${interaction.member.voice.channel.id})`);
            return interaction.member.voice.channel;
        }

        // Method 2: Try fetching from voice states directly (fast, no API call)
        try {
            const voiceState = interaction.guild.voiceStates.cache.get(interaction.user.id);
            if (voiceState?.channel) {
                console.log(`Voice channel found via voice states cache: ${voiceState.channel.name} (${voiceState.channel.id})`);
                return voiceState.channel;
            }
        } catch (voiceStateError) {
            console.error('Error checking voice states cache:', voiceStateError);
        }

        // Method 3: Force fresh fetch of member data (slowest, but most reliable)
        // Only use this if explicitly requested and with timeout protection
        if (useForceFetch) {
            try {
                const fetchPromise = interaction.guild.members.fetch({
                    user: interaction.user.id,
                    force: true // This forces Discord to fetch fresh data instead of using cache
                });

                const timeoutPromise = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Member fetch timeout')), timeout)
                );

                const member = await Promise.race([fetchPromise, timeoutPromise]);

                if (member?.voice?.channel) {
                    console.log(`Voice channel found via fresh fetch: ${member.voice.channel.name} (${member.voice.channel.id})`);
                    return member.voice.channel;
                }
            } catch (fetchError) {
                console.warn('Error fetching member with force (timed out or failed):', fetchError.message);
            }
        }

        console.log(`User ${interaction.user.tag} is not in any voice channel`);
        return null;
    } catch (error) {
        console.error('Error in getUserVoiceChannel:', error);
        return null;
    }
}

module.exports = {
    getUserVoiceChannel
};
