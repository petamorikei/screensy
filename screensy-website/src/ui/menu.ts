import { getElement } from "../dom.ts";
import { formatBitrate, NO_VALUE } from "../format.ts";
import type { QualitySettings } from "../quality.ts";
import { BitrateSchema, DEFAULT_QUALITY, DegradationSchema, FrameRateSchema, MaxHeightSchema } from "../quality.ts";
import type { ConnectionStats, StatsDirection } from "../stats.ts";

const COPY_FEEDBACK_MS = 2000;

/**
 * The menu (#menu, a popover): the link with a copy button, the own name, the participants, the connection
 * statistics and the quality settings
 */
export class Menu {
  /**
   * The name typed in the menu, trimmed. It may be empty.
   */
  public onnamechange: ((name: string) => void) | null = null;
  public onmenutoggle: ((open: boolean) => void) | null = null;
  public onqualitychange: ((quality: QualitySettings) => void) | null = null;

  private readonly displayName: (name: string | undefined, participantId: string) => string;
  private readonly frameRateSelect: HTMLSelectElement;
  private readonly resolutionSelect: HTMLSelectElement;
  private readonly bitrateInput: HTMLInputElement;
  private readonly degradationSelect: HTMLSelectElement;
  private readonly roomLink: HTMLInputElement;
  private readonly copyLinkDone: HTMLElement;
  private readonly copyLinkFailed: HTMLElement;
  private readonly menuNameInput: HTMLInputElement;
  private readonly participantList: HTMLElement;
  private readonly participantsSection: HTMLElement;
  private readonly qualitySection: HTMLElement;
  private copyFeedbackTimer: number | null = null;
  private readonly statsList: HTMLElement;
  private readonly statsEmpty: HTMLElement;
  private readonly statsTemplate: HTMLTemplateElement;
  private readonly statsNames: HTMLElement;
  private readonly youText: string;
  private readonly presentingText: string;
  private readonly reconnectingText: string;

  /**
   * The settings shown in the menu. An invalid input goes back to them.
   */
  private quality: QualitySettings = DEFAULT_QUALITY;

  /**
   * @param displayName Returns the name to display for a participant
   */
  constructor(displayName: (name: string | undefined, participantId: string) => string) {
    this.displayName = displayName;
    this.frameRateSelect = getElement("quality-frame-rate", HTMLSelectElement);
    this.resolutionSelect = getElement("quality-resolution", HTMLSelectElement);
    this.bitrateInput = getElement("quality-bitrate", HTMLInputElement);
    this.degradationSelect = getElement("quality-degradation", HTMLSelectElement);
    this.roomLink = getElement("room-link", HTMLInputElement);
    this.copyLinkDone = getElement("copy-link-done", HTMLElement);
    this.copyLinkFailed = getElement("copy-link-failed", HTMLElement);
    this.menuNameInput = getElement("menu-name-input", HTMLInputElement);
    this.participantList = getElement("participant-list", HTMLElement);
    this.participantsSection = getElement("menu-participants", HTMLElement);
    this.qualitySection = getElement("menu-quality", HTMLElement);
    this.statsList = getElement("stats-list", HTMLElement);
    this.statsEmpty = getElement("stats-empty", HTMLElement);
    this.statsTemplate = getElement("stats-template", HTMLTemplateElement);
    this.statsNames = getElement("stats-names", HTMLElement);
    this.youText = getElement("text-you", HTMLElement).textContent.trim();
    this.presentingText = getElement("text-presenting", HTMLElement).textContent.trim();
    this.reconnectingText = getElement("text-reconnecting", HTMLElement).textContent.trim();

    const menu = getElement("menu", HTMLElement);
    menu.addEventListener("toggle", () => this.onmenutoggle?.(menu.matches(":popover-open")));

    // The page reloads when the hash changes, so the link stays the same
    this.roomLink.value = location.href;
    getElement("copy-link-button", HTMLButtonElement).addEventListener("click", () => this.copyLink());

    this.menuNameInput.addEventListener("change", () => this.onnamechange?.(this.menuNameInput.value.trim()));

    this.frameRateSelect.addEventListener("change", () => {
      const frameRate = FrameRateSchema.safeParse(Number(this.frameRateSelect.value));
      this.changeQuality(frameRate.success ? { frameRate: frameRate.data } : null);
    });

    this.resolutionSelect.addEventListener("change", () => {
      const maxHeight = MaxHeightSchema.safeParse(
        this.resolutionSelect.value === "" ? null : Number(this.resolutionSelect.value),
      );
      this.changeQuality(maxHeight.success ? { maxHeight: maxHeight.data } : null);
    });

    this.bitrateInput.addEventListener("change", () => {
      const maxBitrateMbps = BitrateSchema.safeParse(this.bitrateInput.valueAsNumber);
      this.changeQuality(
        this.bitrateInput.checkValidity() && maxBitrateMbps.success ? { maxBitrateMbps: maxBitrateMbps.data } : null,
      );
    });

    this.degradationSelect.addEventListener("change", () => {
      const degradation = DegradationSchema.safeParse(this.degradationSelect.value);
      this.changeQuality(degradation.success ? { degradation: degradation.data } : null);
    });
  }

  /**
   * Shows the own name in the menu, unless it is being edited
   */
  setOwnName(name: string): void {
    if (document.activeElement !== this.menuNameInput) {
      this.menuNameInput.value = name;
    }
  }

  /**
   * Lists the participants in the menu. Names come from other people, so they are only ever set as text.
   */
  showParticipants(
    participants: { id: string; name: string; you: boolean; presenting: boolean; reconnecting: boolean }[],
  ): void {
    const items = participants.map((participant) => {
      const item = document.createElement("li");
      const name = document.createElement("span");
      name.className = "participant-name";
      name.textContent = this.displayName(participant.name, participant.id);
      item.append(name);

      const badges: string[] = [];

      if (participant.presenting) {
        badges.push(participant.reconnecting ? this.reconnectingText : this.presentingText);
      }

      if (participant.you) {
        badges.push(this.youText);
      }

      for (const text of badges) {
        const badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = text;
        item.append(badge);
      }

      return item;
    });

    this.participantList.replaceChildren(...items);

    for (const slot of this.participantsSection.querySelectorAll(".count-slot")) {
      slot.textContent = participants.length.toString();
    }
  }

  /**
   * Shows the statistics of each connection, from the copy of #stats-template, or #stats-empty without any
   */
  showStats(entries: { name: string; direction: StatsDirection; stats: ConnectionStats }[]): void {
    this.statsEmpty.classList.toggle("hidden", entries.length > 0);

    const blocks = entries.map((entry) => {
      const fragment = this.statsTemplate.content.cloneNode(true) as DocumentFragment;
      const stats = entry.stats;
      const values: Record<string, string> = {
        state: this.statsName("state", stats.state),
        route: this.statsName("route", stats.route),
        video: stats.videoCodec ?? NO_VALUE,
        resolution: stats.width == null || stats.height == null ? NO_VALUE : `${stats.width}×${stats.height}`,
        frameRate: stats.frameRate == null ? NO_VALUE : `${Math.round(stats.frameRate)} fps`,
        bitrate: formatBitrate(stats.bitrate),
        audio: stats.audioCodec ?? NO_VALUE,
        roundTripTime: stats.roundTripTime == null ? NO_VALUE : `${Math.round(stats.roundTripTime * 1000)} ms`,
        packetLoss: stats.packetLoss == null ? NO_VALUE : `${(stats.packetLoss * 100).toFixed(1)}%`,
        limitation: this.statsName("limitation", stats.limitation),
      };

      for (const name of fragment.querySelectorAll(".stats-name")) {
        name.textContent = entry.name;
      }

      // The presenter can both send to and receive from another presenter
      for (const direction of fragment.querySelectorAll(".stats-direction")) {
        direction.textContent = this.statsName("direction", entry.direction);
      }

      for (const field of fragment.querySelectorAll<HTMLElement>("[data-field]")) {
        field.textContent = values[field.dataset.field ?? ""] ?? NO_VALUE;
      }

      // Only the presenter's encoder lowers the quality
      for (const element of fragment.querySelectorAll("[data-send-only]")) {
        element.classList.toggle("hidden", entry.direction !== "send");
      }

      return fragment;
    });

    this.statsList.replaceChildren(...blocks);
  }

  showQualitySection(visible: boolean): void {
    this.qualitySection.classList.toggle("hidden", !visible);
  }

  /**
   * Shows the quality settings in the menu
   */
  setQuality(quality: QualitySettings): void {
    this.quality = quality;
    this.frameRateSelect.value = quality.frameRate.toString();
    this.resolutionSelect.value = quality.maxHeight?.toString() ?? "";
    this.bitrateInput.value = quality.maxBitrateMbps.toString();
    this.degradationSelect.value = quality.degradation;
  }

  /**
   * The translated name of a state, a route or a limitation, from #stats-names
   */
  private statsName(kind: "state" | "route" | "limitation" | "direction", value: string | null): string {
    if (value == null) {
      return NO_VALUE;
    }

    const element = this.statsNames.querySelector(`[data-${kind}="${CSS.escape(value)}"]`);
    return element?.textContent.trim() ?? value;
  }

  private copyLink(): void {
    const succeed = () => this.showCopyFeedback(this.copyLinkDone);
    const fail = () => {
      // Let the person copy it themselves
      this.roomLink.focus();
      this.roomLink.select();
      this.showCopyFeedback(this.copyLinkFailed);
    };

    if (navigator.clipboard == null) {
      fail();
      return;
    }

    navigator.clipboard.writeText(this.roomLink.value).then(succeed, fail);
  }

  private showCopyFeedback(element: HTMLElement): void {
    this.copyLinkDone.classList.add("hidden");
    this.copyLinkFailed.classList.add("hidden");
    element.classList.remove("hidden");

    if (this.copyFeedbackTimer != null) {
      window.clearTimeout(this.copyFeedbackTimer);
    }

    // The failure stays, because the person still has to copy the link
    this.copyFeedbackTimer =
      element === this.copyLinkDone
        ? window.setTimeout(() => this.copyLinkDone.classList.add("hidden"), COPY_FEEDBACK_MS)
        : null;
  }

  /**
   * Reports a valid change, or puts the inputs back to the current settings
   */
  private changeQuality(change: Partial<QualitySettings> | null): void {
    if (change == null) {
      this.setQuality(this.quality);
      return;
    }

    this.quality = { ...this.quality, ...change };
    this.onqualitychange?.(this.quality);
  }
}
