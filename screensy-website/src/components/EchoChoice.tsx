import { Affix, Alert, Button, Group, Text } from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";
import { useAtomValue } from "jotai";
import { t } from "../i18n/index.ts";
import { callAtom } from "../state/atoms.ts";
import { useController } from "./controller.ts";

/**
 * Asks, until the presenter answers, whether to hear the call or to share the sound that would carry it back
 */
export const EchoChoice = () => {
  const controller = useController();
  const { echoChoice } = useAtomValue(callAtom);

  if (!echoChoice) {
    return null;
  }

  return (
    <Affix position={{ bottom: 80, left: "50%" }} style={{ transform: "translateX(-50%)" }}>
      <Alert
        data-testid="echo-choice"
        role="alertdialog"
        aria-labelledby="echo-choice-text"
        color="yellow"
        icon={<IconAlertTriangle />}
        maw={560}
      >
        <Text id="echo-choice-text" size="sm" mb="sm">
          {t("call.echo")}
        </Text>
        <Group gap="xs">
          <Button data-testid="echo-choice-call" size="xs" onClick={() => controller.chooseEcho("call")}>
            {t("call.echoCall")}
          </Button>
          <Button
            data-testid="echo-choice-screen"
            size="xs"
            variant="default"
            onClick={() => controller.chooseEcho("screen")}
          >
            {t("call.echoScreen")}
          </Button>
        </Group>
      </Alert>
    </Affix>
  );
};
