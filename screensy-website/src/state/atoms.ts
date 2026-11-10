import { atom, createStore } from "jotai";
import { readBlurStrength } from "../blur.ts";
import { DEFAULT_QUALITY } from "../quality.ts";
import type {
  CallView,
  ChatView,
  DevicesView,
  DialogView,
  ParticipantView,
  QualityView,
  StageView,
  StatsEntryView,
  ToolbarView,
  UnsupportedId,
} from "./views.ts";

/**
 * The store that the controllers write and the React components read. The controllers live outside React, so they
 * set the atoms on this store, and the app renders inside a Provider of it.
 */
export const store = createStore();

export const stageAtom = atom<StageView>({ tiles: [], status: "connecting", echoMuted: false });

export const toolbarAtom = atom<ToolbarView>({
  visible: false,
  canPresent: false,
  presenting: false,
  hidden: false,
  blurred: false,
  canBlur: false,
  busy: false,
  viewers: 0,
});

export const blurStrengthAtom = atom(readBlurStrength());

/**
 * The start or resume dialog, or null while it is closed
 */
export const dialogAtom = atom<DialogView | null>(null);

export const chatAtom = atom<ChatView>({ entries: [], enabled: false, open: 0, total: 0, liveCount: 0 });

export const callAtom = atom<CallView>({
  ready: false,
  supported: false,
  joined: false,
  joining: false,
  muted: false,
  camera: false,
  cameraBusy: false,
  members: [],
  audio: [],
  audioMuted: false,
  echoChoice: false,
});

export const devicesAtom = atom<DevicesView>({
  supported: false,
  canChooseSpeaker: false,
  lists: { microphone: [], camera: [], speaker: [] },
  choice: { microphone: "", camera: "", speaker: "" },
});

export const participantsAtom = atom<ParticipantView[]>([]);

/**
 * The own name, as the server has it: the menu shows it unless it is being edited
 */
export const ownNameAtom = atom("");

/**
 * The statistics of each connection, collected while the menu is open
 */
export const statsAtom = atom<StatsEntryView[]>([]);

export const qualityAtom = atom<QualityView>({ visible: false, settings: DEFAULT_QUALITY });

/**
 * What the browser lacks, or null
 */
export const unsupportedAtom = atom<UnsupportedId | null>(null);
