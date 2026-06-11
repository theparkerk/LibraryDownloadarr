// Device-named transcode presets → Plex universal-transcoder params.
// Adding a preset here is all it takes to expose a new quality button.

export interface TranscodePreset {
  id: string; // stable key sent by the client
  label: string; // shown in the UI
  videoResolution: string; // WxH cap
  maxVideoBitrate: number; // kbps
  videoQuality: number; // Plex 0..100 quality knob
}

export const TRANSCODE_PRESETS: Record<string, TranscodePreset> = {
  '720p': {
    id: '720p',
    label: 'iPhone (720p)',
    videoResolution: '1280x720',
    maxVideoBitrate: 2500,
    videoQuality: 60,
  },
  '1080p': {
    id: '1080p',
    label: 'iPad / Mac (1080p)',
    videoResolution: '1920x1080',
    // ~3 GB target for a ~2h movie: 3000k ×1.15 (VideoToolbox bump in
    // transcodeService) ≈ 3.45 Mbps video + 192k audio ≈ 3 GB. Was 8000k,
    // which produced a 7.9 GB Tropic Thunder.
    maxVideoBitrate: 3000,
    videoQuality: 75,
  },
};

export const getPreset = (id: string): TranscodePreset | undefined => TRANSCODE_PRESETS[id];
