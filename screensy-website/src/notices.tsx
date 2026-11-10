import { notifications } from "@mantine/notifications";
import type { MessageKey } from "./i18n/index.ts";
import { t } from "./i18n/index.ts";

/**
 * The notices at the bottom of the page, which close by themselves
 */
export type NoticeId =
  | "taken-over"
  | "moved-to-other-tab"
  | "connection-lost"
  | "access-denied"
  | "switch-failed"
  | "blur-failed"
  | "full"
  | "echo-muted"
  | "microphone-denied"
  | "call-audio-blocked"
  | "camera-denied"
  | "cameras-full"
  | "file-mismatch"
  | "screensharing-unsupported";

const TEXTS: Record<NoticeId, MessageKey> = {
  "taken-over": "notice.takenOver",
  "moved-to-other-tab": "notice.movedToOtherTab",
  "connection-lost": "notice.connectionLost",
  "access-denied": "notice.accessDenied",
  "switch-failed": "notice.switchFailed",
  "blur-failed": "notice.blurFailed",
  full: "notice.full",
  "echo-muted": "notice.echoMuted",
  "microphone-denied": "notice.microphoneDenied",
  "call-audio-blocked": "notice.callAudioBlocked",
  "camera-denied": "notice.cameraDenied",
  "cameras-full": "notice.camerasFull",
  "file-mismatch": "notice.fileMismatch",
  "screensharing-unsupported": "unsupported.screensharing.text",
};

const NOTICE_TIMEOUT_MS = 10000;

/**
 * Shows a notice. The same notice again replaces the one that is shown. The name, if any, comes from someone else, and
 * React inserts it as text.
 */
export const showNotice = (id: NoticeId, name = ""): void => {
  notifications.hide(id);
  notifications.show({
    id,
    message: <span data-testid={`notice-${id}`}>{t(TEXTS[id], { name })}</span>,
    autoClose: NOTICE_TIMEOUT_MS,
    withBorder: true,
  });
};
