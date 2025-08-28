// ext/tts_service.js

import { logger, storage } from './utils.js';

const ttsService = {
  /**
   * Generates audio from text using a standard TTS endpoint.
   */
  async generateAudio(text) {
    const settings = await storage.getSettings();
    const apiKey = settings.elevenlabsApiKey;

    if (!apiKey) {
      return { success: false, error: 'ElevenLabs API key not configured.' };
    }

    const response = await fetch('https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM', {
      method: 'POST',
      headers: {
        'Accept': 'audio/mpeg',
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.5,
        },
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      logger.error('ttsService:generateAudio', 'API error', JSON.stringify(errorData, null, 2));
      return { success: false, error: errorData.detail?.message || 'Unknown API error' };
    }

    const audioBlob = await response.blob();
    return { success: true, audioBlob };
  },

  /**
   * Gets timestamps for an existing audio file and script using the Forced Alignment API.
   * Used to generate the data needed for "Moments".
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
      return { success: true, wordTimestamps: resultData.words || [] };

    } catch (error) {
      logger.error('ttsService:getAlignmentForExistingAudio', 'Error during forced alignment', error);
      return { success: false, error: error.message };
    }
  }
};

export default ttsService;