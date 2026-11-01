/**
 * What the menu shows about one connection. Values that the browser does not report are null.
 */
export interface ConnectionStats {
  state: RTCPeerConnectionState;
  route: "direct" | "relay" | null;
  videoCodec: string | null;
  audioCodec: string | null;
  width: number | null;
  height: number | null;
  frameRate: number | null;
  /**
   * Video and audio together, in bits per second, since the previous sample
   */
  bitrate: number | null;
  /**
   * In seconds
   */
  roundTripTime: number | null;
  /**
   * The share of lost packets since the previous sample, from 0 to 1
   */
  packetLoss: number | null;
  /**
   * Why the encoder lowers the quality: "none", "bandwidth", "cpu" or "other". Only for sent streams.
   */
  limitation: string | null;
}

export type StatsDirection = "receive" | "send";

export type StatsEntry = Record<string, unknown>;

export const statNumber = (entry: StatsEntry | undefined, key: string): number | null => {
  const value = entry?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

export const statString = (entry: StatsEntry | undefined, key: string): string | null => {
  const value = entry?.[key];
  return typeof value === "string" ? value : null;
};

/**
 * Reads getStats() of connections. It keeps the previous sample of each connection, to turn the byte and packet
 * counters into a bitrate and a loss rate.
 */
export class StatsCollector {
  private readonly previous = new WeakMap<
    RTCPeerConnection,
    { timestamp: number; bytes: number; lost: number; packets: number }
  >();

  async collect(connection: RTCPeerConnection, direction: StatsDirection): Promise<ConnectionStats> {
    const report = await connection.getStats();
    const entries = new Map<string, StatsEntry>();
    report.forEach((entry: StatsEntry, id: string) => {
      entries.set(id, entry);
    });

    const rtpType = direction === "receive" ? "inbound-rtp" : "outbound-rtp";
    let video: StatsEntry | undefined;
    let audio: StatsEntry | undefined;
    let pair: StatsEntry | undefined;
    const remoteInbound: StatsEntry[] = [];

    for (const entry of entries.values()) {
      if (entry.type === rtpType) {
        if (entry.kind === "video") {
          video = entry;
        } else if (entry.kind === "audio") {
          audio = entry;
        }
      } else if (entry.type === "remote-inbound-rtp") {
        remoteInbound.push(entry);
      } else if (entry.type === "transport") {
        const pairId = statString(entry, "selectedCandidatePairId");
        pair = pairId == null ? pair : entries.get(pairId);
      }
    }

    pair ??= [...entries.values()].find(
      (entry) => entry.type === "candidate-pair" && entry.nominated === true && entry.state === "succeeded",
    );

    const localType = statString(entries.get(statString(pair, "localCandidateId") ?? ""), "candidateType");
    const remoteType = statString(entries.get(statString(pair, "remoteCandidateId") ?? ""), "candidateType");
    const route =
      localType == null || remoteType == null
        ? null
        : localType === "relay" || remoteType === "relay"
          ? "relay"
          : "direct";

    // A sender without a track, such as the audio of a capture without audio, still reports a codec. Only name the
    // codec of packets that actually flow.
    const packetKey = direction === "receive" ? "packetsReceived" : "packetsSent";
    const codec = (rtp: StatsEntry | undefined) => {
      if ((statNumber(rtp, packetKey) ?? 0) === 0) {
        return null;
      }

      const mimeType = statString(entries.get(statString(rtp, "codecId") ?? ""), "mimeType");
      return mimeType?.split("/")[1] ?? null;
    };

    // Counters for the rates
    const byteKey = direction === "receive" ? "bytesReceived" : "bytesSent";
    const bytes = (statNumber(video, byteKey) ?? 0) + (statNumber(audio, byteKey) ?? 0);
    let lost: number;
    let packets: number;

    if (direction === "receive") {
      lost = (statNumber(video, "packetsLost") ?? 0) + (statNumber(audio, "packetsLost") ?? 0);
      packets = lost + (statNumber(video, "packetsReceived") ?? 0) + (statNumber(audio, "packetsReceived") ?? 0);
    } else {
      lost = remoteInbound.reduce((sum, entry) => sum + (statNumber(entry, "packetsLost") ?? 0), 0);
      packets = (statNumber(video, "packetsSent") ?? 0) + (statNumber(audio, "packetsSent") ?? 0);
    }

    const timestamp = statNumber(video, "timestamp") ?? statNumber(pair, "timestamp") ?? performance.now();
    const previous = this.previous.get(connection);
    this.previous.set(connection, { timestamp, bytes, lost, packets });

    let bitrate: number | null = null;
    let packetLoss: number | null = packets > 0 ? lost / packets : null;

    if (previous != null && timestamp > previous.timestamp) {
      bitrate = ((bytes - previous.bytes) * 8 * 1000) / (timestamp - previous.timestamp);

      const newPackets = packets - previous.packets;
      packetLoss = newPackets > 0 ? Math.max(0, lost - previous.lost) / newPackets : packetLoss;
    }

    const remoteVideo = remoteInbound.find((entry) => entry.kind === "video");

    return {
      state: connection.connectionState,
      route,
      videoCodec: codec(video),
      audioCodec: codec(audio),
      width: statNumber(video, "frameWidth"),
      height: statNumber(video, "frameHeight"),
      frameRate: statNumber(video, "framesPerSecond"),
      bitrate,
      roundTripTime:
        (direction === "send" ? statNumber(remoteVideo, "roundTripTime") : null) ??
        statNumber(pair, "currentRoundTripTime"),
      packetLoss,
      limitation: direction === "send" ? statString(video, "qualityLimitationReason") : null,
    };
  }
}
