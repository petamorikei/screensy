// The "breakout box" of Chrome and Edge, which lib.dom does not declare yet. Its streams keep running when the tab is
// in the background, unlike requestAnimationFrame and timers.
declare class MediaStreamTrackProcessor {
  constructor(init: { track: MediaStreamTrack });
  readonly readable: ReadableStream<VideoFrame>;
}

declare class MediaStreamTrackGenerator extends MediaStreamTrack {
  constructor(init: { kind: "video" });
  readonly writable: WritableStream<VideoFrame>;
}
