import {
  ActionIcon,
  Anchor,
  Button,
  CloseButton,
  Group,
  Paper,
  Progress,
  ScrollArea,
  Stack,
  Text,
  Textarea,
  Title,
  Tooltip,
} from "@mantine/core";
import { IconDownload, IconFile, IconPaperclip, IconSend } from "@tabler/icons-react";
import { useAtomValue } from "jotai";
import type { KeyboardEvent } from "react";
import { useLayoutEffect, useRef, useState } from "react";
import { MAX_CHAT_TEXT_LENGTH } from "../chat-protocol.ts";
import { pageLanguage, t } from "../i18n/index.ts";
import { chatAtom } from "../state/atoms.ts";
import type { ChatEntryView, ChatFileView } from "../state/views.ts";
import { useController } from "./controller.ts";

/**
 * Whether the scroll position is at the end of the log, give or take a few pixels
 */
const AT_END_PX = 20;

const timeFormat = new Intl.DateTimeFormat(pageLanguage(), { hour: "2-digit", minute: "2-digit" });

/**
 * The name and size of a file, and what this page can do with it. The name comes from someone else: React inserts it
 * as text.
 */
const FileRow = (props: { file: ChatFileView; onResume: (fileId: string) => void }) => {
  const controller = useController();
  const { file } = props;

  const note = (text: string) => (
    <Text size="xs" c="dimmed" data-testid="chat-file-note">
      {text}
    </Text>
  );

  return (
    <Paper withBorder p="xs" data-testid="chat-file" data-file-id={file.id} data-status={file.status}>
      <Group gap="xs" wrap="nowrap">
        <IconFile size={18} />
        <Text size="sm" style={{ overflowWrap: "anywhere" }} data-testid="chat-file-name">
          {file.name}
        </Text>
        <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }} data-testid="chat-file-size">
          {file.size}
        </Text>
      </Group>
      <Group gap="xs" mt={6}>
        {file.status === "ended" && (
          <>
            {note(t("file.ended"))}
            <Button size="compact-xs" variant="default" onClick={() => props.onResume(file.id)}>
              {t("file.resume")}
            </Button>
          </>
        )}
        {file.status === "stopped" && note(t("file.stopped"))}
        {file.status === "unreachable" && note(t("file.unreachable"))}
        {(file.status === "idle" || file.status === "failed") && (
          <Button
            size="compact-xs"
            variant="default"
            leftSection={<IconDownload size={14} />}
            onClick={() => controller.downloadFile(file.id)}
          >
            {file.status === "idle" ? t("file.download") : t("file.retry")}
          </Button>
        )}
        {file.status === "receiving" && (
          <>
            <Progress value={file.progress * 100} flex={1} data-testid="chat-file-progress" />
            <Button size="compact-xs" variant="default" onClick={() => controller.cancelDownload(file.id)}>
              {t("file.cancel")}
            </Button>
          </>
        )}
        {file.status === "done" && file.url != null && (
          <Anchor size="sm" href={file.url} download={file.name} data-testid="chat-file-save">
            {t("file.save")}
          </Anchor>
        )}
      </Group>
    </Paper>
  );
};

const Message = (props: { entry: ChatEntryView; onResume: (fileId: string) => void }) => {
  const { entry } = props;
  const date = new Date(entry.sentAt);
  const valid = !Number.isNaN(date.getTime());

  return (
    <Stack gap={4} data-testid="chat-message" data-self={entry.self || undefined}>
      <Group gap="xs" align="baseline">
        <Text size="sm" fw={600} c={entry.self ? "blue.3" : undefined} data-testid="chat-name">
          {entry.name}
        </Text>
        {valid && (
          <Text component="time" dateTime={date.toISOString()} size="xs" c="dimmed">
            {timeFormat.format(date)}
          </Text>
        )}
      </Group>
      {entry.file != null && <FileRow file={entry.file} onResume={props.onResume} />}
      {entry.text !== "" && (
        <Text size="sm" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }} data-testid="chat-text">
          {entry.text}
        </Text>
      )}
    </Stack>
  );
};

/**
 * The chat beside the stage: the messages, how many of the others it reaches, and the input. Enter sends and
 * Shift+Enter adds a line, except while an input method composes text: its Enter confirms the conversion. Safari
 * reports the confirming Enter as keyCode 229 after the composition has ended.
 */
export const ChatPanel = (props: { onClose: () => void }) => {
  const controller = useController();
  const chat = useAtomValue(chatAtom);
  const [text, setText] = useState("");
  const viewport = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  const fileInput = useRef<HTMLInputElement>(null);
  const resumeInput = useRef<HTMLInputElement>(null);
  const resumeFileId = useRef<string | null>(null);

  // The log follows new messages if it was scrolled to the end
  useLayoutEffect(() => {
    const element = viewport.current;

    if (element != null && atEnd.current && chat.entries.length > 0) {
      element.scrollTop = element.scrollHeight;
    }
  }, [chat.entries]);

  const send = () => {
    const trimmed = text.trim();

    if (trimmed !== "" && controller.sendChat(trimmed)) {
      setText("");
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      send();
    }
  };

  const onResume = (fileId: string) => {
    resumeFileId.current = fileId;
    resumeInput.current?.click();
  };

  const reach = chat.total === 0 ? t("chat.alone") : t("chat.reach", { open: chat.open, total: chat.total });

  return (
    <Stack h="100%" gap={0} data-testid="chat" aria-label={t("chat.title")}>
      <Group justify="space-between" p="sm" pb={0}>
        <Title order={2} size="h4">
          {t("chat.title")}
        </Title>
        <CloseButton data-testid="chat-close" aria-label={t("chat.close")} onClick={props.onClose} />
      </Group>
      <Text
        px="sm"
        size="xs"
        c={chat.open < chat.total ? "yellow" : "dimmed"}
        data-testid="chat-reach"
        data-partial={chat.open < chat.total || undefined}
      >
        {reach}
      </Text>
      <ScrollArea
        flex={1}
        viewportRef={viewport}
        onScrollPositionChange={() => {
          const element = viewport.current;

          if (element != null) {
            atEnd.current = element.scrollHeight - element.scrollTop - element.clientHeight < AT_END_PX;
          }
        }}
      >
        <Stack gap="md" p="sm" data-testid="chat-log">
          {chat.entries.map((entry) => (
            <Message key={entry.key} entry={entry} onResume={onResume} />
          ))}
        </Stack>
      </ScrollArea>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <Group gap="xs" p="sm" align="flex-end" wrap="nowrap">
          <Textarea
            data-testid="chat-input"
            flex={1}
            autosize
            minRows={1}
            maxRows={6}
            maxLength={MAX_CHAT_TEXT_LENGTH}
            placeholder={t("chat.placeholder")}
            aria-label={t("chat.message")}
            disabled={!chat.enabled}
            value={text}
            onChange={(event) => setText(event.currentTarget.value)}
            onKeyDown={onKeyDown}
          />
          <Tooltip label={t("chat.attach")}>
            <ActionIcon
              data-testid="chat-attach"
              variant="default"
              size="lg"
              aria-label={t("chat.attach")}
              disabled={!chat.enabled}
              onClick={() => fileInput.current?.click()}
            >
              <IconPaperclip size={18} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label={t("chat.send")}>
            <ActionIcon
              data-testid="chat-send"
              type="submit"
              size="lg"
              aria-label={t("chat.send")}
              disabled={!chat.enabled}
            >
              <IconSend size={18} />
            </ActionIcon>
          </Tooltip>
        </Group>
        <input
          ref={fileInput}
          data-testid="chat-file-input"
          type="file"
          multiple
          hidden
          onChange={(event) => {
            for (const file of event.currentTarget.files ?? []) {
              controller.attachFile(file);
            }

            event.currentTarget.value = "";
          }}
        />
        <input
          ref={resumeInput}
          data-testid="chat-resume-input"
          type="file"
          hidden
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];

            if (file != null && resumeFileId.current != null) {
              controller.resumeFile(resumeFileId.current, file);
            }

            event.currentTarget.value = "";
          }}
        />
      </form>
    </Stack>
  );
};
