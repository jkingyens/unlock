// ext/tts_service.js

import { logger, storage } from './utils.js';

const ttsService = {
  /**
   * Generates audio and timestamps simultaneously from text.
   * Used for the initial packet creation.
   */
  async generateAudioAndTimestamps(text) {
    const settings = await storage.getSettings();
    const apiKey = settings.elevenlabsApiKey;

    if (!apiKey) {
      return { success: false, error: 'ElevenLabs API key not configured.' };
    }

    // Use the endpoint for simultaneous synthesis and timestamp generation
    const response = await fetch('https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM/with-timestamps', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: text,
        model_id: 'eleven_multilingual_v2', // v2 model is required for alignment features
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.5,
        },
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      logger.error('ttsService:generateAudioAndTimestamps', 'API error', JSON.stringify(errorData, null, 2));
      return { success: false, error: errorData.detail?.message || 'Unknown API error' };
    }

    const responseData = await response.json();
    const audioBase64 = responseData.audio_base_64;
    const wordTimestamps = responseData.alignment?.word_timestamps;
    
    if (!audioBase64) {
      return { success: false, error: "API response did not contain audio data." };
    }

    const audioBlob = new Blob([Uint8Array.from(atob(audioBase64), c => c.charCodeAt(0))], { type: 'audio/mpeg' });

    return { success: true, audioBlob, wordTimestamps: wordTimestamps || [] };
  },

  /**
   * Gets timestamps for an existing audio file and script using the Forced Alignment API.
   * Used by the "Add Timestamps" button in the packet builder.
   */
  async getAlignmentForExistingAudio(audioBuffer, plainText) {
    const settings = await storage.getSettings();
    const apiKey = settings.elevenlabsApiKey;

    if (!apiKey) {
      return { success: false, error: 'ElevenLabs API key not configured.' };
    }

    try {
      const formData = new FormData();
      formData.append('file', new Blob([audioBuffer], { type: 'audio/mpeg' }), 'audio.mp3');
      formData.append('text', plainText);

      const response = await fetch('https://api.elevenlabs.io/v1/forced-alignment', {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
        },
        body: formData,
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail?.message || 'Failed to start alignment job.');
      }

      const resultData = await response.json();
      console.log(JSON.stringify(resultData), null, 2);
      return { success: true, wordTimestamps: resultData.words || [] };

    } catch (error) {
      logger.error('ttsService:getAlignmentForExistingAudio', 'Error during forced alignment', error);
      return { success: false, error: error.message };
    }
  }
};

export default ttsService;