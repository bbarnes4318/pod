// The episode page's player and its transcript talk through two window events,
// so neither has to own the other. Positions are fractions (0-1) of the audio.
export const PLAYER_SEEK = "studio:player-seek"; // detail: number — seek there and play
export const PLAYER_TIME = "studio:player-time"; // detail: number — where playback is now
