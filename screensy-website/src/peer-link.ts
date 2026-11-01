/**
 * Wraps an RTCPeerConnection and holds back ICE candidates until the remote description is set.
 */
export class PeerLink {
  public readonly connection: RTCPeerConnection;

  private pendingCandidates: RTCIceCandidateInit[] = [];
  private hasRemoteDescription = false;

  constructor(rtcConfig: RTCConfiguration) {
    this.connection = new RTCPeerConnection(rtcConfig);
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    await this.connection.setRemoteDescription(description);
    this.hasRemoteDescription = true;

    const candidates = this.pendingCandidates;
    this.pendingCandidates = [];

    for (const candidate of candidates) {
      await this.connection.addIceCandidate(candidate);
    }
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.hasRemoteDescription) {
      this.pendingCandidates.push(candidate);
      return;
    }

    await this.connection.addIceCandidate(candidate);
  }

  close(): void {
    this.connection.close();
  }
}
