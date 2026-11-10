import type { MessageRoomState, MessageSignalFromServer, MessageWelcome, ServerMessage } from "screensy-protocol";
import { BLUR_STORAGE_KEY, isBlurSupported, readBlurStrength } from "./blur.ts";
import { CallController } from "./call-controller.ts";
import { capturesOwnAudio } from "./capture.ts";
import { Chat } from "./chat.ts";
import type { ChatFile, ChatMessage } from "./chat-protocol.ts";
import { cleanFileName, FileTransfers } from "./file-transfer.ts";
import { formatBytes } from "./format.ts";
import { displayName, t } from "./i18n/index.ts";
import { IncomingStream } from "./incoming-stream.ts";
import { showNotice } from "./notices.tsx";
import { OutgoingStream } from "./outgoing-stream.ts";
import { PeerMesh } from "./peer-mesh.ts";
import type { QualitySettings } from "./quality.ts";
import { displayMediaOptions, readQuality, writeQuality } from "./quality.ts";
import type { MessageSender } from "./signaling.ts";
import { SignalingConnection } from "./signaling.ts";
import {
  blurStrengthAtom,
  chatAtom,
  dialogAtom,
  ownNameAtom,
  participantsAtom,
  qualityAtom,
  stageAtom,
  statsAtom,
  store,
  toolbarAtom,
  unsupportedAtom,
} from "./state/atoms.ts";
import type { ChatFileView, StatusId, TileView } from "./state/views.ts";
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
import { cameraTileViews, ownTile, tileViews } from "./tile-views.ts";

/**
 * Which way to go when the shared sound would carry the call back: keep hearing the call without the shared sound, or
 * share the sound and mute the call on this page
 */
export type EchoChoice = "call" | "screen";

const STATS_INTERVAL_MS = 1000;

/**
 * The name of a file as a chat message carries it: within the limit of the message. The size is not limited.
 */
const chatFileName = (file: File): string => file.name.slice(0, 255) || "file";

/**
 * The participant who sends a stream that this client may receive: a live presenter, or a participant in the call
 */
const streamOwner = (state: MessageRoomState, streamId: string): string | null => {
  const presenter = state.presenters.find(
    (presenter) => presenter.streamId === streamId && presenter.status === "live",
  );
  const call = state.calls.find((call) => call.streamId === streamId);
  return presenter?.participantId ?? call?.participantId ?? null;
};

/**
 * Keeps this client in sync with the room: presents the local screen, receives the screens of others, and shows the
 * state of the room.
 */
export class RoomController {
  private readonly roomId: string;
  private readonly signaling: SignalingConnection;
  /**
   * The STUN servers from the latest "welcome". New connections always take the latest ones.
   */
  private rtcConfig: RTCConfiguration = { iceServers: [] };
  private readonly canPresent: boolean;
  private readonly sendMessage: MessageSender;

  private selfId: string | null = null;

  /**
   * This client's connection ID from the latest "welcome"
   */
  private connectionId: string | null = null;
  private state: MessageRoomState | null = null;

  /**
   * The connections without media to every other participant, for the chat
   */
  private readonly mesh: PeerMesh;
  private readonly chat: Chat;
  private readonly files: FileTransfers;

  /**
   * The chat messages as the chat last showed them, to show them again when a file transfer changes
   */
  private chatMessages: readonly ChatMessage[] = [];

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

  /**
   * The received streams, by stream ID: the presentations and the microphones of the participants in the call
   */
  private readonly incoming = new Map<string, IncomingStream>();

  /**
   * This client's part of the call
   */
  public readonly call: CallController;

  /**
   * The choice about the shared sound, which belongs to one capture: a new screen asks again
   */
  private echoChoice: { stream: MediaStream; choice: EchoChoice } | null = null;

  /**
   * Set by "welcome" while presenting: the next "roomstate" decides whether this client still holds its seat.
   */
  private resolveOnNextState = false;

  /**
   * Whether to open the start dialog when the room state first arrives, for the person who created the room
   */
  private offerToPresent: boolean;

  private dialogMode: "start" | "resume" | null = null;

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
    this.quality = readQuality();
    store.set(qualityAtom, { visible: this.canPresent, settings: this.quality });
    store.set(ownNameAtom, this.storedName());

    const webSocketProtocol = window.location.protocol === "http:" ? "ws" : "wss";
    this.signaling = new SignalingConnection(`${webSocketProtocol}://${location.host}${location.pathname}`);
    this.sendMessage = (message) => this.signaling.send(message);

    this.mesh = new PeerMesh(() => this.rtcConfig, this.sendMessage);
    this.chat = new Chat(this.roomId, this.mesh);
    this.mesh.onopen = (peerId: string) => {
      this.chat.handlePeerOpen(peerId);
      this.render();
    };
    this.files = new FileTransfers(this.mesh, () => this.chat.ownAuthors);
    this.mesh.onclose = (peerId: string) => {
      this.files.handleClose(peerId);
      this.render();
    };
    this.mesh.onmessage = (peerId: string, data: string) => this.chat.handleData(peerId, data);
    this.mesh.onfilesopen = (peerId: string) => this.files.handleOpen(peerId);
    this.mesh.onfilesmessage = (peerId: string, data: string | ArrayBuffer) => this.files.handleMessage(peerId, data);
    this.files.onchange = () => this.showChat(this.chatMessages);
    this.chat.onchange = (messages: readonly ChatMessage[]) => this.showChat(messages);
    this.chat.onlive = () => store.set(chatAtom, (chat) => ({ ...chat, liveCount: chat.liveCount + 1 }));
    this.call = new CallController({
      sendMessage: this.sendMessage,
      rtcConfig: () => this.rtcConfig,
      render: () => this.render(),
      room: () => (this.state == null || this.selfId == null ? null : { state: this.state, selfId: this.selfId }),
      incoming: (streamId: string) => this.incoming.get(streamId),
    });

    this.signaling.onopen = () => {
      // Reached at last: the page works
      if (store.get(unsupportedAtom) === "websocket-failed") {
        store.set(unsupportedAtom, null);
      }

      this.join();
    };
    this.signaling.onclose = () => this.render();
    this.signaling.onmessage = (message: ServerMessage) => this.handleMessage(message);

    this.signaling.onconnectfailed = () => store.set(unsupportedAtom, "websocket-failed");

    const roomIdWords = roomId.split(/(?=[A-Z])/);
    document.title = `${roomIdWords.join(" ")} | screensy`;
  }

  start(): void {
    this.render();
    this.signaling.connect();
  }

  close(): void {
    this.signaling.close();
    this.mesh.reset();
    this.chat.close();
    this.files.close();
    this.call.stop();
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
      case "meshsignal":
        this.mesh.handleSignal(message).catch((error) => console.warn("Could not handle a mesh signal.", error));
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
          showNotice("full");
          this.render();
        } else {
          this.loseSeat();
        }

        break;
      case "camerarejected":
        this.call.handleCameraRejected();
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

    this.mesh.reset();
    this.outgoing?.stop();
    this.outgoing = null;
    this.resolveOnNextState = false;
    // The other tab has to join the call itself
    this.call.stop();

    if (this.dialogMode === "resume") {
      this.closeDialog();
    }

    if (hadSeat) {
      showNotice("moved-to-other-tab");
    }

    this.render();
  }

  private handleWelcome(message: MessageWelcome): void {
    this.selfId = message.selfId;
    this.connectionId = message.connectionId;
    this.maxPresenters = message.maxPresenters;
    this.rtcConfig = { iceServers: message.iceServers };
    writeStorage(getSessionStorage, this.resumeStorageKey, message.resumeToken);

    // The connection ID changed, so every presenter opens new connections to this client, and the mesh is rebuilt.
    // The chat asks the peers for what it missed meanwhile.
    this.closeIncoming();
    this.mesh.reset();
    this.chat.setRoomInstance(message.roomInstanceId);

    if (this.outgoing != null) {
      // A "present" may have been lost with the old socket. The next room state tells whether the seat is still ours.
      this.outgoing.reset();
      this.resolveOnNextState = true;
    }

    this.call.handleWelcome();
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
      store.set(ownNameAtom, self.name);
    }

    this.showParticipants(state, selfId);

    if (this.connectionId != null) {
      this.mesh.sync(state.participants, selfId, this.connectionId);
    }

    this.call.handleRoomState(state, selfId);

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
        store.set(dialogAtom, { mode: "resume", full: null, name: this.storedName() });
      }
    } else if (this.dialogMode === "resume") {
      // The seat expired or was taken while the resume dialog was open
      this.closeDialog();
      this.showSeatLostNotice();
    }

    for (const [streamId, stream] of this.incoming) {
      const participant = state.participants.find((participant) => participant.id === stream.presenterId);

      if (
        streamOwner(state, streamId) !== stream.presenterId ||
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
          showNotice("screensharing-unsupported");
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

    if (this.call.handleSignal(message)) {
      return;
    }

    const state = this.state;

    if (state == null) {
      return;
    }

    const participant = state.participants.find((participant) => participant.id === message.from);

    if (streamOwner(state, message.streamId) !== message.from || participant?.connectionId !== message.fromConnection) {
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

  openStartDialog(): void {
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
    store.set(dialogAtom, { mode: "start", full, name: this.storedName() });
    this.render();
  }

  /**
   * Starts or resumes presenting with the name and the presenter to take over from the dialog. Must be called in the
   * handler of the click: getDisplayMedia comes first, while the click still counts as a user activation.
   */
  confirmDialog(name: string, replace: string | null): void {
    const mode = this.dialogMode;
    this.closeDialog();

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
        showNotice("access-denied");

        if (mode === "resume") {
          this.sendMessage({ type: "stoppresenting" });
        }

        this.render();
      },
    );
  }

  cancelDialog(): void {
    if (this.dialogMode === "resume") {
      this.sendMessage({ type: "stoppresenting" });
    }

    this.closeDialog();
    this.render();
  }

  private closeDialog(): void {
    this.dialogMode = null;
    store.set(dialogAtom, null);
  }

  private beginPresenting(mediaStream: MediaStream, name: string, resume: boolean, replace: string | null): void {
    this.outgoing?.stop();

    const outgoing = new OutgoingStream(
      mediaStream,
      () => this.rtcConfig,
      this.sendMessage,
      this.quality,
      this.blurStrength,
      (stream: MediaStream) => this.screenAudioSuppressed(stream),
    );
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
   * Lets the presenter choose another screen, without reconnecting to the viewers. Must be called in the handler of
   * the click, like confirmDialog.
   */
  switchScreen(): void {
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
            showNotice("switch-failed");
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
   * Remembers the choice about the shared sound for the current capture
   */
  chooseEcho(choice: EchoChoice): void {
    if (this.outgoing != null) {
      this.echoChoice = { stream: this.outgoing.mediaStream, choice };
      this.render();
    }
  }

  /**
   * Remembers the name and tells the room. While disconnected, the next "join" carries it.
   */
  changeName(name: string): void {
    writeStorage(getLocalStorage, NAME_STORAGE_KEY, name);
    store.set(ownNameAtom, name);

    if (this.signaling.isOpen && this.selfId != null) {
      this.sendMessage({ type: "setname", name });
    }
  }

  /**
   * Sends a chat message with the own participant ID and name, as the latest room state has them
   */
  sendChat(text: string): boolean {
    const self = this.state?.participants.find((participant) => participant.id === this.selfId);

    if (self == null) {
      return false;
    }

    return this.chat.send(text, self.id, self.name);
  }

  /**
   * Shares a file in the chat: the others ask this page for it
   */
  attachFile(file: File): boolean {
    const self = this.state?.participants.find((participant) => participant.id === this.selfId);

    if (self == null) {
      return false;
    }

    const shared: ChatFile = {
      id: this.files.share(file),
      name: chatFileName(file),
      size: file.size,
      type: file.type.slice(0, 255),
    };

    return this.chat.send("", self.id, self.name, shared);
  }

  /**
   * Shares the file of an own message again, after a reload forgot it: the person chooses it again, and it has to
   * have the same name and size
   */
  resumeFile(fileId: string, file: File): void {
    const message = this.chatMessages.find((message) => message.file?.id === fileId);

    if (message?.file == null || !this.chat.isOwn(message)) {
      return;
    }

    if (chatFileName(file) !== message.file.name || file.size !== message.file.size) {
      showNotice("file-mismatch");
      return;
    }

    this.files.share(file, fileId);
    this.showChat(this.chatMessages);
  }

  cancelDownload(fileId: string): void {
    this.files.cancel(fileId);
  }

  downloadFile(fileId: string): void {
    const message = this.chatMessages.find((message) => message.file?.id === fileId);

    if (message?.file != null) {
      this.files.download(message.file);
    }
  }

  private showChat(messages: readonly ChatMessage[]): void {
    this.chatMessages = messages;
    store.set(chatAtom, (chat) => ({
      ...chat,
      entries: messages.map((message) => ({
        key: `${message.authorId}:${message.seq}`,
        name: displayName(message.name, message.participantId),
        sentAt: message.sentAt,
        text: message.text,
        self: this.chat.isOwn(message),
        file: message.file == null ? null : this.fileView(message, message.file),
      })),
    }));
  }

  /**
   * What this page can do with the file of a message
   */
  private fileView(message: ChatMessage, file: ChatFile): ChatFileView {
    const view: ChatFileView = {
      id: file.id,
      // The name comes from someone else
      name: cleanFileName(file.name),
      size: formatBytes(file.size),
      status: "idle",
      progress: 0,
      url: null,
    };

    if (this.chat.isOwn(message)) {
      // A reload forgets the files that this page shared
      return { ...view, status: this.files.holds(file.id) ? "own" : "ended" };
    }

    const state = this.files.state(file.id);

    switch (state.status) {
      case "receiving":
        return { ...view, status: "receiving", progress: state.size === 0 ? 1 : state.received / state.size };
      case "done":
        return { ...view, status: "done", url: state.url };
      default:
        if (this.files.isAvailable(file.id)) {
          return { ...view, status: state.status };
        }

        // Nobody here has it: the sender stopped sharing it with a reload, or left
        return { ...view, status: this.files.isAuthorHere(message.authorId) ? "stopped" : "unreachable" };
    }
  }

  private showParticipants(state: MessageRoomState, selfId: string): void {
    const seats = new Map(state.presenters.map((presenter) => [presenter.participantId, presenter]));
    const inCall = new Set(state.calls.map((call) => call.participantId));
    const rank = (id: string) => (seats.has(id) ? 0 : id === selfId ? 1 : 2);
    const participants = [...state.participants].sort((a, b) => rank(a.id) - rank(b.id));

    store.set(
      participantsAtom,
      participants.map((participant) => ({
        id: participant.id,
        name: displayName(participant.name, participant.id),
        you: participant.id === selfId,
        presenting: seats.has(participant.id),
        reconnecting: seats.get(participant.id)?.status === "reconnecting",
        inCall: inCall.has(participant.id),
      })),
    );
  }

  /**
   * The name of a connection of the call in the statistics
   */
  private callName(participantId: string): string {
    return t("stats.call", { name: this.nameOf(participantId) });
  }

  /**
   * Collects the statistics while the menu is open
   */
  setMenuOpen(open: boolean): void {
    if (open) {
      // The names of the devices show once the page may use them
      void this.call.refreshDevices();
    }

    if (open && this.statsTimer == null) {
      this.statsTimer = window.setInterval(() => void this.updateStats(), STATS_INTERVAL_MS);
      void this.updateStats();
    } else if (!open && this.statsTimer != null) {
      window.clearInterval(this.statsTimer);
      this.statsTimer = null;
      store.set(statsAtom, []);
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
      const targets: { key: string; name: string; direction: StatsDirection; connection: RTCPeerConnection }[] = [];

      for (const { participantId, connection } of this.outgoing?.connections() ?? []) {
        targets.push({ key: `send:${participantId}`, name: this.nameOf(participantId), direction: "send", connection });
      }

      // The call: what this client sends, and what it receives from the others in the call
      for (const { participantId, connection } of this.call.connections()) {
        targets.push({
          key: `call-send:${participantId}`,
          name: this.callName(participantId),
          direction: "send",
          connection,
        });
      }

      for (const call of this.state?.calls ?? []) {
        const stream = this.incoming.get(call.streamId);

        if (call.participantId !== this.selfId && stream != null) {
          targets.push({
            key: `call-receive:${call.participantId}`,
            name: this.callName(call.participantId),
            direction: "receive",
            connection: stream.connection,
          });
        }
      }

      for (const presenter of this.state?.presenters ?? []) {
        const stream = this.incoming.get(presenter.streamId);

        if (presenter.participantId !== this.selfId && presenter.status === "live" && stream != null) {
          targets.push({
            key: `receive:${presenter.participantId}`,
            name: this.nameOf(presenter.participantId),
            direction: "receive",
            connection: stream.connection,
          });
        }
      }

      const entries = await Promise.all(
        targets.map(async (target) => ({
          key: target.key,
          name: target.name,
          direction: target.direction,
          stats: await this.statsCollector.collect(target.connection, target.direction),
        })),
      );

      // The menu may have closed meanwhile
      if (this.statsTimer != null) {
        store.set(statsAtom, entries);
      }
    } catch (error) {
      console.warn("Could not read the connection statistics.", error);
    } finally {
      this.collectingStats = false;
    }
  }

  changeQuality(quality: QualitySettings): void {
    this.quality = quality;
    writeQuality(quality);
    store.set(qualityAtom, { visible: this.canPresent, settings: quality });
    this.outgoing?.setQuality(quality);
  }

  /**
   * Applies the quality settings again, after the size of the own preview changed: a resized shared window changes the
   * scale factor
   */
  refreshQuality(): void {
    this.outgoing?.refreshQuality();
  }

  setBlurred(blurred: boolean): void {
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
          showNotice("blur-failed");
        }
      })
      .finally(() => {
        this.trackChangeInProgress = false;
        this.render();
      });
  }

  changeBlurStrength(strength: number): void {
    this.blurStrength = strength;
    store.set(blurStrengthAtom, strength);
    writeStorage(getLocalStorage, BLUR_STORAGE_KEY, strength.toString());
    this.outgoing?.setBlurStrength(strength);
  }

  setHidden(hidden: boolean): void {
    this.outgoing?.setHidden(hidden);
    this.render();
  }

  stopPresenting(): void {
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
      showNotice("connection-lost");
    } else {
      showNotice("taken-over", this.nameOf(presenter.participantId));
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
    return displayName(participant?.name, participantId);
  }

  /**
   * Updates the video, the status and the toolbar from the current state.
   */
  private render(): void {
    const state = this.state;
    const ready = this.signaling.isOpen && state != null && this.selfId != null;
    const tiles = ready ? [...tileViews(this.tileContext(), state), ...cameraTileViews(this.tileContext(), state)] : [];

    // While the server is away, only the own preview stays
    if (!ready && this.outgoing != null) {
      tiles.push(ownTile(this.tileContext()));
    }

    let status: StatusId | null = null;

    if (!this.signaling.everConnected) {
      status = "connecting";
    } else if (!this.signaling.isOpen) {
      status = "server-reconnecting";
    } else if (state == null) {
      status = "connecting";
    } else if (tiles.length === 0) {
      status = "waiting";
    }

    const echo = this.updateEchoProtection(tiles);
    store.set(stageAtom, { tiles, status, echoMuted: echo.echoMuted });
    store.set(chatAtom, (chat) => ({
      ...chat,
      enabled: ready && this.chat.ready,
      open: this.mesh.openPeers().length,
      total: this.mesh.targetCount,
    }));
    this.call.show(ready, (participantId) => this.nameOf(participantId), echo);

    const counting = tiles.some((tile) => tile.countdown != null);

    if (counting && this.countdownTimer == null) {
      this.countdownTimer = window.setInterval(() => this.render(), 1000);
    } else if (!counting && this.countdownTimer != null) {
      window.clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }

    const viewers =
      state?.participants.filter((participant) => participant.connected && participant.id !== this.selfId).length ?? 0;

    store.set(toolbarAtom, {
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
      ownCamera: this.call.ownCamera,
      speaking: (participantId) => this.call.isSpeaking(participantId),
    };
  }

  /**
   * Whether this page plays the call: someone else is in it
   */
  private hearsCall(): boolean {
    return this.state?.calls.some((call) => call.participantId !== this.selfId) ?? false;
  }

  /**
   * Whether a capture would send the call back to the room: its sound may contain this page's sound, which plays the
   * call. The echo canceller of the microphone does not help, because the capture copies the sound digitally.
   */
  private echoConflict(stream: MediaStream): boolean {
    return capturesOwnAudio(stream) && this.hearsCall();
  }

  private echoChoiceFor(stream: MediaStream): EchoChoice | null {
    return this.echoChoice?.stream === stream ? this.echoChoice.choice : null;
  }

  /**
   * The sound of a capture is not sent while it would carry the call back, unless the person chose to share it
   */
  private screenAudioSuppressed(stream: MediaStream): boolean {
    return this.echoConflict(stream) && this.echoChoiceFor(stream) !== "screen";
  }

  /**
   * Mutes the other presenters on this page while the own capture may contain this page's sound. With the call, the
   * shared sound is off until the person chooses between it and hearing the call.
   */
  private updateEchoProtection(tiles: TileView[]): { echoMuted: boolean; echoChoice: boolean; audioMuted: boolean } {
    const outgoing = this.outgoing;
    const needed = outgoing != null && capturesOwnAudio(outgoing.mediaStream);

    if (!needed) {
      this.echoNoticeShown = false;
    } else if (!this.echoNoticeShown && tiles.some((tile) => !tile.self)) {
      this.echoNoticeShown = true;
      showNotice("echo-muted");
    }

    outgoing?.refreshTrackStates();

    const conflict = outgoing != null && this.echoConflict(outgoing.mediaStream);
    const choice = outgoing == null ? null : this.echoChoiceFor(outgoing.mediaStream);
    return { echoMuted: needed, echoChoice: conflict && choice == null, audioMuted: conflict && choice === "screen" };
  }
}
