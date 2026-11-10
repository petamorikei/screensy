import {
  ActionIcon,
  Anchor,
  Button,
  CloseButton,
  Group,
  Image,
  Modal,
  Overlay,
  Paper,
  Progress,
  ScrollArea,
  Stack,
  Text,
  Textarea,
  Title,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { IconDownload, IconFile, IconPaperclip, IconSend } from "@tabler/icons-react";
import { useAtomValue } from "jotai";
import type { DragEvent, KeyboardEvent } from "react";
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
 * Whether a drag carries files, and not text or a link, which the input takes as usual
 */
const carriesFiles = (event: DragEvent): boolean => event.dataTransfer.types.includes("Files");

/**
 * The dropped files, without the folders, which the browser lists as files that cannot be read
 */
const droppedFiles = (data: DataTransfer): File[] =>
  [...data.items].flatMap((item) => {
    if (item.kind !== "file" || item.webkitGetAsEntry()?.isDirectory) {
      return [];
    }

    const file = item.getAsFile();
    return file == null ? [] : [file];
  });

/**
 * The height of a preview in the log, fixed so that the log keeps following its end while the image loads
 */
const PREVIEW_HEIGHT = 160;

/**
 * The preview of an image in the log, which opens it larger in a dialog
 */
const ImagePreview = (props: { name: string; url: string }) => {
  const [open, setOpen] = useState(false);

  return (
    <>
      <UnstyledButton
        data-testid="chat-file-preview"
        aria-label={t("file.enlarge", { name: props.name })}
        onClick={() => setOpen(true)}
        display="block"
        w="100%"
        mb={6}
      >
        <Image src={props.url} alt={props.name} w="100%" h={PREVIEW_HEIGHT} fit="scale-down" radius="sm" bg="dark.8" />
      </UnstyledButton>
      <Modal opened={open} onClose={() => setOpen(false)} title={props.name} size="auto" centered>
        <Image data-testid="image-viewer" src={props.url} alt={props.name} mah="80vh" maw="100%" fit="contain" />
      </Modal>
    </>
  );
};

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
      {file.preview != null && <ImagePreview name={file.name} url={file.preview} />}
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
            <Button
              data-testid="chat-file-resume"
              size="compact-xs"
              variant="default"
              onClick={() => props.onResume(file.id)}
            >
              {t("file.resume")}
            </Button>
          </>
        )}
        {file.status === "stopped" && note(t("file.stopped"))}
        {file.status === "unreachable" && note(t("file.unreachable"))}
        {(file.status === "idle" || file.status === "failed") && (
          <Button
            data-testid="chat-file-download"
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
            <Button
              data-testid="chat-file-cancel"
              size="compact-xs"
              variant="default"
              onClick={() => controller.cancelDownload(file.id)}
            >
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
  const [dragging, setDragging] = useState(false);
  // Entering a child fires "dragenter" before "dragleave" of the parent, so the drag is over the panel while this is
  // above 0
  const dragDepth = useRef(0);

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

  // Files dropped anywhere on the chat are attached like those of the attach button
  const onDragEnter = (event: DragEvent) => {
    if (carriesFiles(event)) {
      event.preventDefault();
      dragDepth.current += 1;
      setDragging(true);
    }
  };

  const onDragOver = (event: DragEvent) => {
    if (carriesFiles(event)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = chat.enabled ? "copy" : "none";
    }
  };

  const onDragLeave = (event: DragEvent) => {
    if (carriesFiles(event)) {
      dragDepth.current = Math.max(0, dragDepth.current - 1);

      if (dragDepth.current === 0) {
        setDragging(false);
      }
    }
  };

  const onDrop = (event: DragEvent) => {
    if (!carriesFiles(event)) {
      return;
    }

    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);

    if (chat.enabled) {
      for (const file of droppedFiles(event.dataTransfer)) {
        controller.attachFile(file);
      }
    }
  };

  return (
    <Stack
      h="100%"
      gap={0}
      pos="relative"
      data-testid="chat"
      aria-label={t("chat.title")}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragging && chat.enabled && (
        <Overlay data-testid="chat-drop" center backgroundOpacity={0.75} zIndex={2} style={{ pointerEvents: "none" }}>
          <Text fw={600}>{t("chat.drop")}</Text>
        </Overlay>
      )}
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
