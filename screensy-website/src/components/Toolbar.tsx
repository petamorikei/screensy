import { ActionIcon, Badge, Button, Group, Indicator, Slider, Text, Tooltip } from "@mantine/core";
import {
  IconArrowsExchange,
  IconBlur,
  IconBlurOff,
  IconEye,
  IconEyeOff,
  IconMenu2,
  IconMessage,
  IconMicrophone,
  IconMicrophoneOff,
  IconPhone,
  IconPhoneOff,
  IconPlayerStop,
  IconScreenShare,
  IconVideo,
  IconVideoOff,
} from "@tabler/icons-react";
import { useAtomValue } from "jotai";
import type { ReactNode } from "react";
import { BLUR_MAX_STRENGTH, BLUR_MIN_STRENGTH } from "../blur.ts";
import { t } from "../i18n/index.ts";
import { blurStrengthAtom, callAtom, toolbarAtom } from "../state/atoms.ts";
import { useController } from "./controller.ts";

const ICON_SIZE = 20;

/**
 * An icon button whose name shows as a tooltip and is its accessible name
 */
const ToolButton = (props: {
  testId: string;
  label: string;
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  color?: string;
  /**
   * Filled for a button that always stands out, like leaving the call; otherwise filled only while pressed
   */
  filled?: boolean;
}) => (
  <Tooltip label={props.label}>
    <ActionIcon
      data-testid={props.testId}
      aria-label={props.label}
      aria-pressed={props.pressed}
      variant={props.filled || props.pressed ? "filled" : "default"}
      color={props.color}
      size="lg"
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.icon}
    </ActionIcon>
  </Tooltip>
);

/**
 * Presenting: start and stop, switch, hide and blur the screen, and the number of viewers
 */
const PresentControls = () => {
  const controller = useController();
  const toolbar = useAtomValue(toolbarAtom);
  const blurStrength = useAtomValue(blurStrengthAtom);

  if (!toolbar.presenting) {
    return toolbar.canPresent ? (
      <Button
        data-testid="present"
        leftSection={<IconScreenShare size={ICON_SIZE} />}
        onClick={() => controller.openStartDialog()}
      >
        {t("toolbar.present")}
      </Button>
    ) : null;
  }

  return (
    <>
      <Button
        data-testid="stop"
        color="red"
        variant="light"
        leftSection={<IconPlayerStop size={ICON_SIZE} />}
        onClick={() => controller.stopPresenting()}
      >
        {t("toolbar.stop")}
      </Button>
      {/* getDisplayMedia runs in the click handler, while the click still counts as a user activation */}
      <ToolButton
        testId="switch"
        label={t("toolbar.switch")}
        icon={<IconArrowsExchange size={ICON_SIZE} />}
        disabled={toolbar.busy}
        onClick={() => controller.switchScreen()}
      />
      {toolbar.hidden ? (
        <ToolButton
          testId="show"
          label={t("toolbar.show")}
          icon={<IconEye size={ICON_SIZE} />}
          pressed
          onClick={() => controller.setHidden(false)}
        />
      ) : (
        <ToolButton
          testId="hide"
          label={t("toolbar.hide")}
          icon={<IconEyeOff size={ICON_SIZE} />}
          onClick={() => controller.setHidden(true)}
        />
      )}
      {toolbar.canBlur && (
        <ToolButton
          testId={toolbar.blurred ? "unblur" : "blur"}
          label={toolbar.blurred ? t("toolbar.unblur") : t("toolbar.blur")}
          icon={toolbar.blurred ? <IconBlurOff size={ICON_SIZE} /> : <IconBlur size={ICON_SIZE} />}
          pressed={toolbar.blurred}
          disabled={toolbar.busy}
          onClick={() => controller.setBlurred(!toolbar.blurred)}
        />
      )}
      {toolbar.canBlur && toolbar.blurred && (
        <Group gap={6} wrap="nowrap">
          <Slider
            data-testid="blur-strength"
            thumbLabel={t("toolbar.blurStrength")}
            w={120}
            min={BLUR_MIN_STRENGTH}
            max={BLUR_MAX_STRENGTH}
            step={1}
            label={null}
            value={blurStrength}
            onChange={(value) => controller.changeBlurStrength(value)}
          />
          <Text
            size="sm"
            w="2ch"
            ta="right"
            style={{ fontVariantNumeric: "tabular-nums" }}
            data-testid="blur-strength-value"
          >
            {blurStrength}
          </Text>
        </Group>
      )}
      <Badge data-testid="viewers" variant="light" size="lg">
        {t("toolbar.viewers", { count: toolbar.viewers })}
      </Badge>
    </>
  );
};

/**
 * The call: join, mute, camera and leave
 */
const CallControls = () => {
  const controller = useController();
  const call = useAtomValue(callAtom);

  if (!call.ready || !call.supported) {
    return null;
  }

  if (!call.joined) {
    return (
      <Button
        data-testid="call-join"
        variant="default"
        leftSection={<IconPhone size={ICON_SIZE} />}
        disabled={call.joining}
        onClick={() => controller.call.join()}
      >
        {t("call.join")}
      </Button>
    );
  }

  return (
    <>
      <ToolButton
        testId="call-mute"
        label={call.muted ? t("call.unmute") : t("call.mute")}
        icon={call.muted ? <IconMicrophoneOff size={ICON_SIZE} /> : <IconMicrophone size={ICON_SIZE} />}
        pressed={call.muted}
        color={call.muted ? "red" : undefined}
        onClick={() => controller.call.setMuted(!call.muted)}
      />
      <ToolButton
        testId="call-camera"
        label={call.camera ? t("call.cameraOff") : t("call.cameraOn")}
        icon={call.camera ? <IconVideo size={ICON_SIZE} /> : <IconVideoOff size={ICON_SIZE} />}
        pressed={call.camera}
        disabled={call.cameraBusy}
        onClick={() => controller.call.setCamera(!call.camera)}
      />
      <ToolButton
        testId="call-leave"
        label={t("call.leave")}
        icon={<IconPhoneOff size={ICON_SIZE} />}
        color="red"
        filled
        onClick={() => controller.call.leave()}
      />
    </>
  );
};

/**
 * The header: presenting on the left, the call, the chat and the menu on the right
 */
export const Toolbar = (props: {
  chatOpen: boolean;
  unread: number;
  onToggleChat: () => void;
  onOpenMenu: () => void;
}) => {
  const toolbar = useAtomValue(toolbarAtom);

  if (!toolbar.visible) {
    return null;
  }

  return (
    <Group data-testid="toolbar" h="100%" px="sm" justify="space-between" wrap="nowrap" gap="xs">
      <Group gap="xs" wrap="nowrap">
        <PresentControls />
      </Group>
      <Group gap="xs" wrap="nowrap">
        <CallControls />
        <Indicator
          data-testid="chat-unread"
          data-unread={props.unread}
          label={props.unread}
          size={18}
          disabled={props.unread === 0}
          offset={4}
        >
          <ToolButton
            testId="chat-toggle"
            label={t("toolbar.chat")}
            icon={<IconMessage size={ICON_SIZE} />}
            pressed={props.chatOpen}
            onClick={props.onToggleChat}
          />
        </Indicator>
        <ToolButton
          testId="menu-open"
          label={t("toolbar.settings")}
          icon={<IconMenu2 size={ICON_SIZE} />}
          onClick={props.onOpenMenu}
        />
      </Group>
    </Group>
  );
};
