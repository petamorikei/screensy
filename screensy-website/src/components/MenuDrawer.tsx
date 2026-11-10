import {
  ActionIcon,
  Badge,
  Divider,
  Drawer,
  Group,
  NativeSelect,
  Paper,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import { useAtomValue } from "jotai";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type { DeviceKind } from "../devices.ts";
import { formatBitrate, NO_VALUE } from "../format.ts";
import type { MessageKey } from "../i18n/index.ts";
import { t } from "../i18n/index.ts";
import type { QualitySettings } from "../quality.ts";
import {
  BITRATES_MBPS,
  BitrateSchema,
  DegradationSchema,
  FrameRateSchema,
  MaxHeightSchema,
  RESOLUTION_HEIGHTS,
} from "../quality.ts";
import { devicesAtom, ownNameAtom, participantsAtom, qualityAtom, statsAtom } from "../state/atoms.ts";
import type { StatsEntryView } from "../state/views.ts";
import { useController } from "./controller.ts";

const COPY_FEEDBACK_MS = 2000;
const MAX_NAME_LENGTH = 32;

const Section = (props: { title: ReactNode; testId: string; children: ReactNode }) => (
  <Stack gap="xs" data-testid={props.testId}>
    <Title order={3} size="h5">
      {props.title}
    </Title>
    {props.children}
  </Stack>
);

/**
 * The link of the room, with a copy button. Without the clipboard, the link is selected for copying by hand.
 */
const LinkSection = () => {
  const input = useRef<HTMLInputElement>(null);
  const [feedback, setFeedback] = useState<"copied" | "failed" | null>(null);
  // The page reloads when the hash changes, so the link stays the same
  const link = location.href;

  useEffect(() => {
    if (feedback !== "copied") {
      return;
    }

    const timer = window.setTimeout(() => setFeedback(null), COPY_FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  const copy = () => {
    const fail = () => {
      input.current?.focus();
      input.current?.select();
      setFeedback("failed");
    };

    if (navigator.clipboard == null) {
      fail();
      return;
    }

    navigator.clipboard.writeText(link).then(() => setFeedback("copied"), fail);
  };

  return (
    <Section title={t("menu.link")} testId="menu-link">
      <TextInput
        ref={input}
        data-testid="room-link"
        readOnly
        value={link}
        aria-label={t("menu.linkLabel")}
        rightSection={
          <Tooltip label={t("menu.copy")}>
            <ActionIcon data-testid="copy-link" variant="subtle" aria-label={t("menu.copy")} onClick={copy}>
              {feedback === "copied" ? <IconCheck size={16} /> : <IconCopy size={16} />}
            </ActionIcon>
          </Tooltip>
        }
      />
      {feedback != null && (
        <Text size="xs" c={feedback === "copied" ? "green" : "yellow"} role="status" data-testid={`copy-${feedback}`}>
          {feedback === "copied" ? t("menu.copied") : t("menu.copyFailed")}
        </Text>
      )}
    </Section>
  );
};

/**
 * The own name: the server's version, unless it is being edited. A change applies when the input loses the focus.
 */
const NameSection = () => {
  const controller = useController();
  const ownName = useAtomValue(ownNameAtom);
  const [draft, setDraft] = useState<string | null>(null);

  const commit = () => {
    if (draft != null && draft.trim() !== ownName) {
      controller.changeName(draft.trim());
    }

    setDraft(null);
  };

  return (
    <Section title={t("menu.name")} testId="menu-name">
      <TextInput
        data-testid="menu-name-input"
        aria-label={t("menu.name")}
        maxLength={MAX_NAME_LENGTH}
        autoComplete="off"
        value={draft ?? ownName}
        onFocus={() => setDraft(ownName)}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.currentTarget.blur();
          }
        }}
      />
    </Section>
  );
};

const ParticipantsSection = () => {
  const participants = useAtomValue(participantsAtom);

  return (
    <Section title={t("menu.participants", { count: participants.length })} testId="menu-participants">
      <Stack gap={6}>
        {participants.map((participant) => (
          <Group key={participant.id} gap={6} data-testid="participant">
            {/* Names come from other people: text only */}
            <Text size="sm" style={{ overflowWrap: "anywhere" }} data-testid="participant-name">
              {participant.name}
            </Text>
            {participant.presenting && (
              <Badge size="sm" variant="light" color={participant.reconnecting ? "yellow" : "red"}>
                {participant.reconnecting ? t("menu.reconnecting") : t("menu.presenting")}
              </Badge>
            )}
            {participant.inCall && (
              <Badge size="sm" variant="light" color="green">
                {t("menu.inCall")}
              </Badge>
            )}
            {participant.you && (
              <Badge size="sm" variant="light" color="gray">
                {t("menu.you")}
              </Badge>
            )}
          </Group>
        ))}
      </Stack>
    </Section>
  );
};

const DEVICE_LABELS: Record<DeviceKind, MessageKey> = {
  microphone: "menu.microphone",
  camera: "menu.camera",
  speaker: "menu.speaker",
};

/**
 * The devices of the call: the default first, then what the browser lists. A chosen device that is gone shows as the
 * default, but stays chosen for when it comes back.
 */
const DevicesSection = () => {
  const controller = useController();
  const devices = useAtomValue(devicesAtom);

  if (!devices.supported) {
    return null;
  }

  const kinds: DeviceKind[] = devices.canChooseSpeaker ? ["microphone", "camera", "speaker"] : ["microphone", "camera"];

  return (
    <Section title={t("menu.devices")} testId="menu-devices">
      {kinds.map((kind) => {
        const list = devices.lists[kind];
        const chosen = devices.choice[kind];
        const kindName = t(DEVICE_LABELS[kind]);

        return (
          <NativeSelect
            key={kind}
            data-testid={`device-${kind}`}
            label={kindName}
            value={list.some((device) => device.id === chosen) ? chosen : ""}
            data={[
              { value: "", label: t("menu.deviceDefault") },
              ...list.map((device, index) => ({
                value: device.id,
                // Device names come from the system: text only
                label:
                  device.label !== "" ? device.label : t("menu.deviceNumbered", { kind: kindName, number: index + 1 }),
              })),
            ]}
            onChange={(event) => controller.call.changeDevice(kind, event.currentTarget.value)}
          />
        );
      })}
      <Text size="xs" c="dimmed">
        {t("menu.devicesNote")}
      </Text>
    </Section>
  );
};

/**
 * The quality of the own presentations. A value that is not one of the choices is not applied.
 */
const QualitySection = () => {
  const controller = useController();
  const quality = useAtomValue(qualityAtom);
  const settings = quality.settings;

  if (!quality.visible) {
    return null;
  }

  const change = (patch: Partial<QualitySettings> | null) => {
    if (patch != null) {
      controller.changeQuality({ ...settings, ...patch });
    }
  };

  return (
    <Section title={t("menu.quality")} testId="menu-quality">
      <NativeSelect
        data-testid="quality-frame-rate"
        label={t("menu.frameRate")}
        value={settings.frameRate.toString()}
        data={[
          { value: "60", label: "60 fps" },
          { value: "30", label: "30 fps" },
        ]}
        onChange={(event) => {
          const frameRate = FrameRateSchema.safeParse(Number(event.currentTarget.value));
          change(frameRate.success ? { frameRate: frameRate.data } : null);
        }}
      />
      <NativeSelect
        data-testid="quality-resolution"
        label={t("menu.resolution")}
        value={settings.maxHeight?.toString() ?? ""}
        data={[
          { value: "", label: t("menu.resolutionOriginal") },
          ...RESOLUTION_HEIGHTS.map((height) => ({ value: height.toString(), label: `${height}p` })),
        ]}
        onChange={(event) => {
          const value = event.currentTarget.value;
          const maxHeight = MaxHeightSchema.safeParse(value === "" ? null : Number(value));
          change(maxHeight.success ? { maxHeight: maxHeight.data } : null);
        }}
      />
      <NativeSelect
        data-testid="quality-bitrate"
        label={t("menu.bitrate")}
        value={settings.maxBitrateMbps.toString()}
        data={BITRATES_MBPS.map((mbps) => ({ value: mbps.toString(), label: `${mbps} Mbps` }))}
        onChange={(event) => {
          const maxBitrateMbps = BitrateSchema.safeParse(Number(event.currentTarget.value));
          change(maxBitrateMbps.success ? { maxBitrateMbps: maxBitrateMbps.data } : null);
        }}
      />
      <NativeSelect
        data-testid="quality-degradation"
        label={t("menu.degradation")}
        value={settings.degradation}
        data={[
          { value: "maintain-resolution", label: t("menu.degradationResolution") },
          { value: "maintain-framerate", label: t("menu.degradationFrameRate") },
          { value: "balanced", label: t("menu.degradationBalanced") },
        ]}
        onChange={(event) => {
          const degradation = DegradationSchema.safeParse(event.currentTarget.value);
          change(degradation.success ? { degradation: degradation.data } : null);
        }}
      />
      <Text size="xs" c="dimmed">
        {t("menu.qualityNote")}
      </Text>
    </Section>
  );
};

/**
 * The translated names of states, routes and limitations
 */
const STATS_NAMES = new Set<string>([
  "stats.state.new",
  "stats.state.connecting",
  "stats.state.connected",
  "stats.state.disconnected",
  "stats.state.failed",
  "stats.state.closed",
  "stats.route.direct",
  "stats.route.relay",
  "stats.limitation.none",
  "stats.limitation.bandwidth",
  "stats.limitation.cpu",
  "stats.limitation.other",
]);

const isStatsName = (name: string): name is MessageKey => STATS_NAMES.has(name);

const statsName = (key: string, value: string | null): string => {
  if (value == null) {
    return NO_VALUE;
  }

  const name = `stats.${key}.${value}`;
  return isStatsName(name) ? t(name) : value;
};

const StatsEntry = ({ entry }: { entry: StatsEntryView }) => {
  const stats = entry.stats;
  const rows: [MessageKey, string][] = [
    ["stats.state", statsName("state", stats.state)],
    ["stats.route", statsName("route", stats.route)],
    ["stats.video", stats.videoCodec ?? NO_VALUE],
    ["stats.resolution", stats.width == null || stats.height == null ? NO_VALUE : `${stats.width}×${stats.height}`],
    ["stats.frameRate", stats.frameRate == null ? NO_VALUE : `${Math.round(stats.frameRate)} fps`],
    ["stats.bitrate", formatBitrate(stats.bitrate)],
    ["stats.audio", stats.audioCodec ?? NO_VALUE],
    ["stats.roundTripTime", stats.roundTripTime == null ? NO_VALUE : `${Math.round(stats.roundTripTime * 1000)} ms`],
    ["stats.packetLoss", stats.packetLoss == null ? NO_VALUE : `${(stats.packetLoss * 100).toFixed(1)}%`],
  ];

  // Only the presenter's encoder lowers the quality
  if (entry.direction === "send") {
    rows.push(["stats.limitation", statsName("limitation", stats.limitation)]);
  }

  return (
    <Paper withBorder p="xs" data-testid="stats-entry" data-direction={entry.direction}>
      <Group gap={6} mb={4}>
        <Text size="sm" fw={600} data-testid="stats-name">
          {entry.name}
        </Text>
        <Badge size="sm" variant="light" data-testid="stats-direction">
          {entry.direction === "send" ? t("stats.direction.send") : t("stats.direction.receive")}
        </Badge>
      </Group>
      <Table withRowBorders={false} verticalSpacing={2} fz="xs">
        <Table.Tbody>
          {rows.map(([label, value]) => (
            <Table.Tr key={label}>
              <Table.Th fw={400} c="dimmed">
                {t(label)}
              </Table.Th>
              <Table.Td data-field={label.slice("stats.".length)}>{value}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Paper>
  );
};

const StatsSection = () => {
  const entries = useAtomValue(statsAtom);

  return (
    <Section title={t("menu.stats")} testId="menu-stats">
      {entries.length === 0 ? (
        <Text size="sm" c="dimmed" data-testid="stats-empty">
          {t("menu.statsEmpty")}
        </Text>
      ) : (
        entries.map((entry) => <StatsEntry key={entry.key} entry={entry} />)
      )}
    </Section>
  );
};

/**
 * The menu, from the side: the link, the own name, the participants, the devices of the call, the quality and the
 * statistics, which are only collected while it is open
 */
export const MenuDrawer = (props: { opened: boolean; onClose: () => void }) => {
  const controller = useController();
  const { opened } = props;

  useEffect(() => {
    controller.setMenuOpen(opened);
  }, [controller, opened]);

  return (
    <Drawer
      opened={opened}
      onClose={props.onClose}
      position="right"
      title={t("menu.title")}
      data-testid="menu"
      closeButtonProps={{ "aria-label": t("menu.close") }}
    >
      <Stack gap="lg">
        <LinkSection />
        <Divider />
        <NameSection />
        <ParticipantsSection />
        <DevicesSection />
        <QualitySection />
        <StatsSection />
      </Stack>
    </Drawer>
  );
};
