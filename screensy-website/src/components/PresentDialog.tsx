import { Button, Group, Modal, Radio, Stack, Text, TextInput } from "@mantine/core";
import { useAtomValue } from "jotai";
import type { FormEvent } from "react";
import { useState } from "react";
import * as z from "zod";
import { t } from "../i18n/index.ts";
import { dialogAtom } from "../state/atoms.ts";
import type { DialogView } from "../state/views.ts";
import { useController } from "./controller.ts";

const MAX_NAME_LENGTH = 32;

/**
 * A presenter needs a name that is more than spaces
 */
const PresenterNameSchema = z.string().trim().min(1).max(MAX_NAME_LENGTH);

const DialogForm = ({ dialog }: { dialog: DialogView }) => {
  const controller = useController();
  const [name, setName] = useState(dialog.name);
  const presenters = dialog.full?.presenters ?? null;
  // With only one presenter to take over, there is nothing to choose
  const [replace, setReplace] = useState<string | null>(presenters?.length === 1 ? (presenters[0]?.id ?? null) : null);
  const parsedName = PresenterNameSchema.safeParse(name);
  const valid = parsedName.success && (presenters == null || replace != null);
  const resume = dialog.mode === "resume";

  // getDisplayMedia runs in this handler, while the click still counts as a user activation
  const submit = (event: FormEvent) => {
    event.preventDefault();

    if (parsedName.success && valid) {
      controller.confirmDialog(parsedName.data, replace);
    }
  };

  return (
    <form onSubmit={submit} data-testid="present-form" data-mode={dialog.mode}>
      <Stack>
        {resume && <Text size="sm">{t("dialog.resumeText")}</Text>}
        {dialog.full != null && presenters != null && (
          <Radio.Group
            data-testid="present-replace"
            label={t("dialog.replace", { max: dialog.full.maxPresenters })}
            value={replace}
            onChange={setReplace}
          >
            <Stack gap={6} mt="xs">
              {presenters.map((presenter) => (
                // Names come from other people: text only
                <Radio
                  key={presenter.id}
                  value={presenter.id}
                  label={presenter.name}
                  data-testid="present-replace-option"
                />
              ))}
            </Stack>
          </Radio.Group>
        )}
        <TextInput
          data-testid="present-name"
          label={t("dialog.name")}
          maxLength={MAX_NAME_LENGTH}
          autoComplete="off"
          required
          data-autofocus
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
        />
        <Group justify="flex-end">
          <Button data-testid="present-cancel" variant="default" onClick={() => controller.cancelDialog()}>
            {resume ? t("dialog.stop") : t("dialog.cancel")}
          </Button>
          <Button data-testid="present-submit" type="submit" disabled={!valid}>
            {resume ? t("dialog.resume") : t("dialog.start")}
          </Button>
        </Group>
      </Stack>
    </form>
  );
};

/**
 * The dialog that starts or resumes presenting: the own name, and in a full room the presenter to take over from
 */
export const PresentDialog = () => {
  const controller = useController();
  const dialog = useAtomValue(dialogAtom);

  return (
    <Modal
      opened={dialog != null}
      onClose={() => controller.cancelDialog()}
      title={dialog?.mode === "resume" ? t("dialog.resumeTitle") : t("dialog.startTitle")}
      data-testid="present-dialog"
      centered
    >
      {/* A new form for every opening, with the name and the choice of that moment */}
      {dialog != null && <DialogForm key={`${dialog.mode}:${dialog.name}:${dialog.full != null}`} dialog={dialog} />}
    </Modal>
  );
};
