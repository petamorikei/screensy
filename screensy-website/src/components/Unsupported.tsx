import { Alert, Center } from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";
import type { MessageKey } from "../i18n/index.ts";
import { t } from "../i18n/index.ts";
import type { UnsupportedId } from "../state/views.ts";

const TEXTS: Record<UnsupportedId, [MessageKey, MessageKey]> = {
  websocket: ["unsupported.websocket.title", "unsupported.websocket.text"],
  webrtc: ["unsupported.webrtc.title", "unsupported.webrtc.text"],
  mediastream: ["unsupported.mediastream.title", "unsupported.mediastream.text"],
  "websocket-failed": ["status.websocketFailed.title", "status.websocketFailed.text"],
};

/**
 * What the browser lacks, or that the server could not be reached, over the whole page
 */
export const Unsupported = ({ reason }: { reason: UnsupportedId }) => {
  const [title, text] = TEXTS[reason];

  return (
    <Center mih="100dvh" p="md">
      <Alert
        data-testid="unsupported"
        data-reason={reason}
        maw={560}
        color="red"
        title={t(title)}
        icon={<IconAlertTriangle />}
      >
        {t(text)}
      </Alert>
    </Center>
  );
};
