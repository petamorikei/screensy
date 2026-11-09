import { getElement } from "../dom.ts";
import { CallAudio } from "./call-audio.ts";
import { CallPanel } from "./call-panel.ts";
import { ChatPanel } from "./chat-panel.ts";
import { PresentDialog } from "./dialog.ts";
import { Menu } from "./menu.ts";
import { Notices } from "./notices.ts";
import { Stage } from "./stage.ts";
import { Toolbar } from "./toolbar.ts";

/**
 * The page elements, in parts. Every translation file has the same element IDs.
 */
export class Ui {
  readonly stage: Stage;
  readonly toolbar: Toolbar;
  readonly menu: Menu;
  readonly dialog: PresentDialog;
  readonly notices: Notices;
  readonly chat: ChatPanel;
  readonly call: CallPanel;
  readonly callAudio: CallAudio;

  private readonly anonymousName: string;

  constructor() {
    this.anonymousName = getElement("text-anonymous", HTMLElement).textContent.trim();
    this.stage = new Stage();
    this.toolbar = new Toolbar();
    this.menu = new Menu((name, participantId) => this.displayName(name, participantId));
    this.dialog = new PresentDialog();
    this.notices = new Notices();
    this.chat = new ChatPanel();
    this.call = new CallPanel();
    this.callAudio = new CallAudio();
  }

  /**
   * Returns the name to display for a participant.
   */
  displayName(name: string | undefined, participantId: string): string {
    // Someone without a name is a guest numbered by the order of joining, the same on every screen
    return name != null && name !== ""
      ? name
      : this.anonymousName.replace("{number}", (Number(participantId) + 1).toString());
  }
}
