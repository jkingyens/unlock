// ext/tts_service.js

import { logger, storage } from './utils.js';

const ttsService = {
  async textToSpeech(text) {
    const settings = await storage.getSettings();
    const apiKey = settings.elevenlabsApiKey;

    if (!apiKey) {
      logger.warn('ttsService', 'ElevenLabs API key not found in settings.');
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
        model_id: 'eleven_monolingual_v1',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.5,
        },
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      logger.error('ttsService', 'ElevenLabs API error', errorData);
      return { success: false, error: errorData.detail.message || 'Unknown ElevenLabs API error' };
    }

    const audioBlob = await response.blob();
    return { success: true, audioBlob };
  },
};

export default ttsService;