import type { MessageRoomState, MessageSignalFromServer, MessageWelcome, ServerMessage } from "screensy-protocol";
import { BLUR_STORAGE_KEY, isBlurSupported, readBlurStrength } from "./blur.ts";
import { capturesOwnAudio } from "./capture.ts";
import { showPopup } from "./dom.ts";
import { IncomingStream } from "./incoming-stream.ts";
import { OutgoingStream } from "./outgoing-stream.ts";
import type { QualitySettings } from "./quality.ts";
import { displayMediaOptions, readQuality, writeQuality } from "./quality.ts";
import type { MessageSender } from "./signaling.ts";
import { SignalingConnection } from "./signaling.ts";
import type { StatsDirection } from "./stats.ts";
import { StatsCollector } from "./stats.ts";
import {
  getLocalStorage,
  getSessionStorage,
  NAME_STORAGE_KEY,
  RESUME_STORAGE_PREFIX,
  readStorage,
  writeStorage,
} from "./storage.ts";
import type { TileContext } from "./tile-views.ts";
import { ownTile, tileViews } from "./tile-views.ts";
import type { DialogMode, StatusId, TileView } from "./ui/types.ts";
import { Ui } from "./ui/ui.ts";

const STATS_INTERVAL_MS = 1000;

/**
 * Keeps this client in sync with the room: presents the local screen, receives the screens of others, and shows the
 * state of the room.
 */
export class RoomController {
  private readonly roomId: string;
  private readonly ui: Ui;
  private readonly signaling: SignalingConnection;
  private readonly rtcConfig: RTCConfiguration;
  private readonly canPresent: boolean;
  private readonly sendMessage: MessageSender;

  private selfId: string | null = null;
  private state: MessageRoomState | null = null;

  /**
   * The room state before the current one, to tell who took over a seat
   */
  private previousState: MessageRoomState | null = null;

  /**
   * The number of people that can present at the same time, from "welcome"
   */
  private maxPresenters = 1;

  /**
   * Whether the notice about muting the other presenters was shown for the current capture
   */
  private echoNoticeShown = false;
  private outgoing: OutgoingStream | null = null;
  private readonly incoming = new Map<string, IncomingStream>();

  /**
   * Set by "welcome" while presenting: the next "roomstate" decides whether this client still holds its seat.
   */
  private resolveOnNextState = false;

  /**
   * Whether to open the start dialog when the room state first arrives, for the person who created the room
   */
  private offerToPresent: boolean;

  private dialogMode: DialogMode | null = null;

  /**
   * When the grace period of each reconnecting presenter ends, by participant ID, in performance.now() time. The
   * server sends the time left, so that the clocks of the server and the client do not need to agree.
   */
  private graceDeadlines = new Map<string, number>();

  /**
   * Re-renders every second while a countdown is shown
   */
  private countdownTimer: number | null = null;

  /**
   * From the click on "Switch screen" until the switch is done or abandoned, or while the blur is turned on or off.
   * Only one of them runs at a time.
   */
  private trackChangeInProgress = false;

  private readonly canBlur = isBlurSupported();

  private blurStrength = readBlurStrength();

  private quality: QualitySettings;

  private readonly statsCollector = new StatsCollector();

  /**
   * Collects the statistics every second while the menu is open
   */
  private statsTimer: number | null = null;
  private collectingStats = false;

  /**
   * @param roomId The ID of the room, as typed in the URL hash
   * @param isCreator Whether this client created the room by opening the page without a hash
   */
  constructor(roomId: string, isCreator: boolean) {
    this.roomId = roomId.toLowerCase();
    this.offerToPresent = isCreator;
    this.canPresent = "getDisplayMedia" in navigator.mediaDevices;
    this.ui = new Ui();
    this.quality = readQuality();
    this.ui.menu.setQuality(this.quality);
    this.ui.menu.showQualitySection(this.canPresent);
    this.ui.menu.setOwnName(this.storedName());

    const webSocketProtocol = window.location.protocol === "http:" ? "ws" : "wss";
    this.signaling = new SignalingConnection(`${webSocketProtocol}://${location.host}${location.pathname}`);
    this.sendMessage = (message) => this.signaling.send(message);

    this.rtcConfig = {
      iceServers: [
        { urls: `stun:${location.hostname}` },
        {
          urls: `turn:${location.hostname}`,
          username: "screensy",
          credential: "screensy",
        },
      ],
    };

    this.signaling.onopen = () => this.join();
    this.signaling.onclose = () => this.render();
    this.signaling.onmessage = (message: ServerMessage) => this.handleMessage(message);

    this.ui.toolbar.onpresent = () => this.openStartDialog();
    this.ui.toolbar.onstop = () => this.stopPresenting();
    this.ui.dialog.onconfirm = (name: string, replace: string | null) => this.confirmDialog(name, replace);
    this.ui.dialog.oncancel = () => this.cancelDialog();
    this.ui.toolbar.onswitch = () => this.switchScreen();
    this.ui.toolbar.onhide = (hidden: boolean) => this.setHidden(hidden);
    this.ui.toolbar.onblur = (blurred: boolean) => this.setBlurred(blurred);
    this.ui.toolbar.onblurstrength = (strength: number) => this.changeBlurStrength(strength);
    this.ui.toolbar.setBlurStrength(this.blurStrength);
    this.ui.menu.onqualitychange = (quality: QualitySettings) => this.changeQuality(quality);
    this.ui.stage.onvideoresize = () => this.outgoing?.refreshQuality();
    this.ui.menu.onnamechange = (name: string) => this.changeName(name);
    this.ui.menu.onmenutoggle = (open: boolean) => this.toggleStats(open);

    const roomIdWords = roomId.split(/(?=[A-Z])/);
    document.title = `${roomIdWords.join(" ")} | screensy`;
  }

  start(): void {
    this.render();
    this.signaling.connect();
  }

  close(): void {
    this.signaling.close();
  }

  private get resumeStorageKey(): string {
    return RESUME_STORAGE_PREFIX + this.roomId;
  }

  private join(): void {
    const resumeToken = readStorage(getSessionStorage, this.resumeStorageKey);

    this.sendMessage({
      type: "join",
      roomId: this.roomId,
      name: readStorage(getLocalStorage, NAME_STORAGE_KEY) ?? "",
      ...(resumeToken == null ? {} : { resumeToken }),
    });
  }

  private handleMessage(message: ServerMessage): void {
    switch (message.type) {
      case "welcome":
        this.handleWelcome(message);
        break;
      case "roomstate":
        this.handleRoomState(message);
        break;
      case "signal":
        this.handleSignal(message);
        break;
      case "presentaccepted":
        if (this.outgoing != null && this.outgoing.streamId == null && !this.resolveOnNextState) {
          this.outgoing.adopt(message.streamId);
        }
        break;
      case "presentrejected":
        if (this.outgoing == null) {
          break;
        }

        if (message.reason === "full") {
          // Someone else filled the room while the dialog was open
          this.outgoing.stop();
          this.outgoing = null;
          this.ui.notices.showNotice("notice-full");
          this.render();
        } else {
          this.loseSeat();
        }

        break;
      case "replaced":
        // Another tab uses this participant. Join as a new participant when the server closes this socket.
        writeStorage(getSessionStorage, this.resumeStorageKey, null);
        this.handleReplaced();
        break;
    }
  }

  /**
   * The seat, if this client had one, now belongs to the other tab, for example a duplicate of this one. Stop here
   * instead of waiting for the next room state, which would report the seat as taken over by this same person.
   */
  private handleReplaced(): void {
    const hadSeat = this.outgoing != null || this.dialogMode === "resume";

    this.outgoing?.stop();
    this.outgoing = null;
    this.resolveOnNextState = false;

    if (this.dialogMode === "resume") {
      this.dialogMode = null;
      this.ui.dialog.close();
    }

    if (hadSeat) {
      this.ui.notices.showNotice("notice-moved-to-other-tab");
    }

    this.render();
  }

  private handleWelcome(message: MessageWelcome): void {
    this.selfId = message.selfId;
    this.maxPresenters = message.maxPresenters;
    writeStorage(getSessionStorage, this.resumeStorageKey, message.resumeToken);

    // The connection ID changed, so every presenter opens new connections to this client
    this.closeIncoming();

    if (this.outgoing != null) {
      // A "present" may have been lost with the old socket. The next room state tells whether the seat is still ours.
      this.outgoing.reset();
      this.resolveOnNextState = true;
    }
  }

  private handleRoomState(state: MessageRoomState): void {
    this.previousState = this.state;
    this.state = state;

    const now = performance.now();
    this.graceDeadlines = new Map(
      state.presenters.flatMap((presenter) =>
        presenter.graceRemainingMs == null ? [] : [[presenter.participantId, now + presenter.graceRemainingMs]],
      ),
    );

    const selfId = this.selfId;

    if (selfId == null) {
      return;
    }

    const ownSeat = state.presenters.find((presenter) => presenter.participantId === selfId);
    const self = state.participants.find((participant) => participant.id === selfId);

    // The server's version of the name, which also follows a change made in the start dialog
    if (self != null) {
      this.ui.menu.setOwnName(self.name);
    }

    this.showParticipants(state, selfId);

    if (this.outgoing != null) {
      if (this.outgoing.streamId == null) {
        if (this.resolveOnNextState) {
          this.resolveOnNextState = false;

          if (ownSeat == null) {
            this.loseSeat();
          } else {
            this.sendMessage({ type: "present", resume: true });
          }
        }
        // Otherwise the "present" is still on its way, and this state may predate it
      } else if (ownSeat == null) {
        this.loseSeat();
      } else if (ownSeat.status === "reconnecting") {
        this.outgoing.reset();
        this.sendMessage({ type: "present", resume: true });
      } else if (ownSeat.streamId === this.outgoing.streamId) {
        this.outgoing.sync(state.participants, selfId);
      }
    } else if (ownSeat != null) {
      if (ownSeat.status === "live") {
        // The seat has no capture behind it
        this.sendMessage({ type: "stoppresenting" });
      } else if (this.dialogMode !== "resume") {
        // This client reloaded while presenting
        this.dialogMode = "resume";
        this.ui.dialog.open("resume", null, this.storedName());
      }
    } else if (this.dialogMode === "resume") {
      // The seat expired or was taken while the resume dialog was open
      this.dialogMode = null;
      this.ui.dialog.close();
      this.showSeatLostNotice();
    }

    for (const [streamId, stream] of this.incoming) {
      const presenter = state.presenters.find((presenter) => presenter.streamId === streamId);
      const participant = state.participants.find((participant) => participant.id === stream.presenterId);

      if (
        presenter == null ||
        presenter.status !== "live" ||
        presenter.participantId !== stream.presenterId ||
        participant?.connectionId !== stream.presenterConnection
      ) {
        stream.close();
        this.incoming.delete(streamId);
      }
    }

    if (this.offerToPresent) {
      this.offerToPresent = false;

      if (this.outgoing == null && ownSeat == null) {
        if (this.canPresent) {
          this.openStartDialog();
        } else {
          showPopup("screensharing-not-supported");
        }
      }
    }

    this.render();
  }

  private handleSignal(message: MessageSignalFromServer): void {
    if (this.outgoing != null && message.streamId === this.outgoing.streamId) {
      this.outgoing.handleSignal(message).catch((error) => console.warn("Could not handle a signal.", error));
      return;
    }

    const state = this.state;

    if (state == null) {
      return;
    }

    const presenter = state.presenters.find(
      (presenter) =>
        presenter.streamId === message.streamId &&
        presenter.participantId === message.from &&
        presenter.status === "live",
    );
    const participant = state.participants.find((participant) => participant.id === message.from);

    if (presenter == null || participant?.connectionId !== message.fromConnection) {
      // A signal of an old stream or an old connection
      return;
    }

    let stream = this.incoming.get(message.streamId);

    if (stream == null) {
      stream = new IncomingStream(
        message.streamId,
        message.from,
        message.fromConnection,
        this.rtcConfig,
        this.sendMessage,
      );
      stream.onstream = () => this.render();
      this.incoming.set(message.streamId, stream);
    }

    stream.handleSignal(message).catch((error) => console.warn("Could not handle a signal.", error));
  }

  private openStartDialog(): void {
    if (this.outgoing != null || !this.canPresent) {
      return;
    }

    // A full room needs one of its presenters to be taken over. Reconnecting presenters still hold their seat.
    const presenters = this.state?.presenters ?? [];
    const full =
      presenters.length >= this.maxPresenters
        ? {
            maxPresenters: this.maxPresenters,
            presenters: presenters.map((presenter) => ({
              id: presenter.participantId,
              name: this.nameOf(presenter.participantId),
            })),
          }
        : null;

    this.dialogMode = "start";
    this.ui.dialog.open("start", full, this.storedName());
    this.render();
  }

  private confirmDialog(name: string, replace: string | null): void {
    const mode = this.dialogMode;
    this.dialogMode = null;

    // Call getDisplayMedia before anything else, while the click still counts as a user activation
    let capture: Promise<MediaStream>;

    try {
      capture = navigator.mediaDevices.getDisplayMedia(displayMediaOptions(this.quality));
    } catch (error) {
      capture = Promise.reject(error);
    }

    writeStorage(getLocalStorage, NAME_STORAGE_KEY, name);
    this.render();

    capture.then(
      (mediaStream: MediaStream) => this.beginPresenting(mediaStream, name, mode === "resume", replace),
      () => {
        this.ui.notices.showNotice("notice-access-denied");

        if (mode === "resume") {
          this.sendMessage({ type: "stoppresenting" });
        }

        this.render();
      },
    );
  }

  private cancelDialog(): void {
    if (this.dialogMode === "resume") {
      this.sendMessage({ type: "stoppresenting" });
    }

    this.dialogMode = null;
    this.render();
  }

  private beginPresenting(mediaStream: MediaStream, name: string, resume: boolean, replace: string | null): void {
    this.outgoing?.stop();

    const outgoing = new OutgoingStream(mediaStream, this.rtcConfig, this.sendMessage, this.quality, this.blurStrength);
    this.outgoing = outgoing;

    this.watchCapture(outgoing, mediaStream);

    const self = this.state?.participants.find((participant) => participant.id === this.selfId);

    if (self?.name !== name) {
      this.sendMessage({ type: "setname", name });
    }

    // If the socket is down, this message is lost, and the next "welcome" resolves it
    this.sendMessage({ type: "present", resume, ...(replace == null ? {} : { replace }) });
    this.render();
  }

  /**
   * Stops presenting when the browser's own "Stop sharing" button ends the capture, as long as it is the current one
   */
  private watchCapture(outgoing: OutgoingStream, mediaStream: MediaStream): void {
    for (const track of mediaStream.getVideoTracks()) {
      track.addEventListener("ended", () => {
        if (this.outgoing === outgoing && outgoing.mediaStream === mediaStream) {
          this.stopPresenting();
        }
      });
    }
  }

  /**
   * Lets the presenter choose another screen, without reconnecting to the viewers
   */
  private switchScreen(): void {
    const outgoing = this.outgoing;

    if (outgoing == null || this.trackChangeInProgress) {
      return;
    }

    // Call getDisplayMedia before anything else, while the click still counts as a user activation
    let capture: Promise<MediaStream>;

    try {
      capture = navigator.mediaDevices.getDisplayMedia(displayMediaOptions(this.quality));
    } catch (error) {
      capture = Promise.reject(error);
    }

    this.trackChangeInProgress = true;
    this.render();

    capture
      .then(
        async (mediaStream: MediaStream) => {
          if (this.outgoing !== outgoing) {
            // Stopped or taken over while the picker was open
            for (const track of mediaStream.getTracks()) {
              track.stop();
            }

            return;
          }

          this.watchCapture(outgoing, mediaStream);
          const switched = await outgoing.replaceCapture(mediaStream);

          if (this.outgoing !== outgoing) {
            return;
          }

          if (!switched) {
            this.ui.notices.showNotice("notice-switch-failed");
          } else if (mediaStream.getVideoTracks()[0]?.readyState === "ended") {
            // Sharing ended before the switch was complete
            this.stopPresenting();
          }
        },
        () => {
          // Cancelled or denied. The current screen stays.
        },
      )
      .finally(() => {
        this.trackChangeInProgress = false;
        this.render();
      });
  }

  /**
   * Remembers the name and tells the room. While disconnected, the next "join" carries it.
   */
  private changeName(name: string): void {
    writeStorage(getLocalStorage, NAME_STORAGE_KEY, name);

    if (this.signaling.isOpen && this.selfId != null) {
      this.sendMessage({ type: "setname", name });
    }
  }

  private showParticipants(state: MessageRoomState, selfId: string): void {
    const seats = new Map(state.presenters.map((presenter) => [presenter.participantId, presenter]));
    const rank = (id: string) => (seats.has(id) ? 0 : id === selfId ? 1 : 2);
    const participants = [...state.participants].sort((a, b) => rank(a.id) - rank(b.id));

    this.ui.menu.showParticipants(
      participants.map((participant) => ({
        id: participant.id,
        name: participant.name,
        you: participant.id === selfId,
        presenting: seats.has(participant.id),
        reconnecting: seats.get(participant.id)?.status === "reconnecting",
      })),
    );
  }

  private toggleStats(open: boolean): void {
    if (open && this.statsTimer == null) {
      this.statsTimer = window.setInterval(() => void this.updateStats(), STATS_INTERVAL_MS);
      void this.updateStats();
    } else if (!open && this.statsTimer != null) {
      window.clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
  }

  /**
   * One entry per viewer that this client sends to, and one per presentation that it receives
   */
  private async updateStats(): Promise<void> {
    if (this.collectingStats) {
      return;
    }

    this.collectingStats = true;

    try {
      const targets: { name: string; direction: StatsDirection; connection: RTCPeerConnection }[] = [];

      for (const { participantId, connection } of this.outgoing?.connections() ?? []) {
        targets.push({ name: this.nameOf(participantId), direction: "send", connection });
      }

      for (const presenter of this.state?.presenters ?? []) {
        const stream = this.incoming.get(presenter.streamId);

        if (presenter.participantId !== this.selfId && presenter.status === "live" && stream != null) {
          targets.push({
            name: this.nameOf(presenter.participantId),
            direction: "receive",
            connection: stream.connection,
          });
        }
      }

      const entries = await Promise.all(
        targets.map(async (target) => ({
          name: target.name,
          direction: target.direction,
          stats: await this.statsCollector.collect(target.connection, target.direction),
        })),
      );

      // The menu may have closed meanwhile
      if (this.statsTimer != null) {
        this.ui.menu.showStats(entries);
      }
    } catch (error) {
      console.warn("Could not read the connection statistics.", error);
    } finally {
      this.collectingStats = false;
    }
  }

  private changeQuality(quality: QualitySettings): void {
    this.quality = quality;
    writeQuality(quality);
    this.outgoing?.setQuality(quality);
  }

  private setBlurred(blurred: boolean): void {
    const outgoing = this.outgoing;

    if (outgoing == null || this.trackChangeInProgress) {
      return;
    }

    this.trackChangeInProgress = true;
    this.render();

    outgoing
      .setBlurred(blurred)
      .then((changed: boolean) => {
        if (!changed && this.outgoing === outgoing) {
          this.ui.notices.showNotice("notice-blur-failed");
        }
      })
      .finally(() => {
        this.trackChangeInProgress = false;
        this.render();
      });
  }

  private changeBlurStrength(strength: number): void {
    this.blurStrength = strength;
    writeStorage(getLocalStorage, BLUR_STORAGE_KEY, strength.toString());
    this.outgoing?.setBlurStrength(strength);
  }

  private setHidden(hidden: boolean): void {
    this.outgoing?.setHidden(hidden);
    this.render();
  }

  private stopPresenting(): void {
    if (this.outgoing == null) {
      return;
    }

    this.sendMessage({ type: "stoppresenting" });
    this.outgoing.stop();
    this.outgoing = null;
    this.render();
  }

  /**
   * Stops the capture after the seat was taken over or lost.
   */
  private loseSeat(): void {
    this.outgoing?.stop();
    this.outgoing = null;
    this.showSeatLostNotice();
    this.render();
  }

  /**
   * Names the presenter who took over the seat: one who is new in the latest room state
   */
  private showSeatLostNotice(): void {
    const before = new Set(this.previousState?.presenters.map((presenter) => presenter.participantId) ?? []);
    const presenter = this.state?.presenters.find(
      (presenter) => presenter.participantId !== this.selfId && !before.has(presenter.participantId),
    );

    if (presenter == null) {
      this.ui.notices.showNotice("notice-connection-lost");
    } else {
      this.ui.notices.showNotice("notice-taken-over", this.nameOf(presenter.participantId));
    }
  }

  private closeIncoming(): void {
    for (const stream of this.incoming.values()) {
      stream.close();
    }

    this.incoming.clear();
  }

  private storedName(): string {
    return readStorage(getLocalStorage, NAME_STORAGE_KEY) ?? "";
  }

  private nameOf(participantId: string): string {
    const participant = this.state?.participants.find((participant) => participant.id === participantId);
    return this.ui.displayName(participant?.name, participantId);
  }

  /**
   * Updates the video, the status and the toolbar from the current state.
   */
  private render(): void {
    const state = this.state;
    const ready = this.signaling.isOpen && state != null && this.selfId != null;
    const tiles = ready ? tileViews(this.tileContext(), state) : [];

    // While the server is away, only the own preview stays
    if (!ready && this.outgoing != null) {
      tiles.push(ownTile(this.tileContext()));
    }

    let status: StatusId | null = null;

    if (!this.signaling.everConnected) {
      status = "status-connecting";
    } else if (!this.signaling.isOpen) {
      status = "status-server-reconnecting";
    } else if (state == null) {
      status = "status-connecting";
    } else if (tiles.length === 0) {
      status = "status-waiting";
    }

    this.ui.stage.showTiles(tiles);
    this.ui.notices.showStatus(status);
    this.updateEchoProtection(tiles);

    const counting = tiles.some((tile) => tile.countdown != null);

    if (counting && this.countdownTimer == null) {
      this.countdownTimer = window.setInterval(() => this.render(), 1000);
    } else if (!counting && this.countdownTimer != null) {
      window.clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }

    const viewers =
      state?.participants.filter((participant) => participant.connected && participant.id !== this.selfId).length ?? 0;

    this.ui.toolbar.show({
      visible: ready || this.outgoing != null,
      canPresent: ready && this.canPresent && this.outgoing == null && this.dialogMode == null,
      presenting: this.outgoing != null,
      hidden: this.outgoing?.hidden ?? false,
      blurred: this.outgoing?.blurred ?? false,
      canBlur: this.canBlur,
      busy: this.trackChangeInProgress,
      viewers,
    });
  }

  /**
   * What the tiles are built from
   */
  private tileContext(): TileContext {
    return {
      selfId: this.selfId,
      outgoing: this.outgoing,
      incomingStream: (streamId) => this.incoming.get(streamId)?.mediaStream ?? null,
      nameOf: (participantId) => this.nameOf(participantId),
      graceDeadline: (participantId) => this.graceDeadlines.get(participantId),
    };
  }

  /**
   * Mutes the other presenters on this page while the own capture may contain this page's sound
   */
  private updateEchoProtection(tiles: TileView[]): void {
    const needed = this.outgoing != null && capturesOwnAudio(this.outgoing.mediaStream);
    this.ui.stage.setEchoMuted(needed);

    if (!needed) {
      this.echoNoticeShown = false;
    } else if (!this.echoNoticeShown && tiles.some((tile) => !tile.self)) {
      this.echoNoticeShown = true;
      this.ui.notices.showNotice("notice-echo-muted");
    }
  }
}
