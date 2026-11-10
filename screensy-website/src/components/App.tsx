import { AppShell, Badge, createTheme, MantineProvider } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { Notifications } from "@mantine/notifications";
import { Provider, useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import type { RoomController } from "../room-controller.ts";
import { chatAtom, store, unsupportedAtom } from "../state/atoms.ts";
import { CallAudio } from "./CallAudio.tsx";
import { ChatPanel } from "./ChatPanel.tsx";
import { ControllerContext } from "./controller.ts";
import { EchoChoice } from "./EchoChoice.tsx";
import { MenuDrawer } from "./MenuDrawer.tsx";
import { PresentDialog } from "./PresentDialog.tsx";
import { Stage } from "./Stage.tsx";
import { Toolbar } from "./Toolbar.tsx";
import { Unsupported } from "./Unsupported.tsx";

const theme = createTheme({
  defaultRadius: "md",
  components: {
    // Badges carry names, which must show as they are written
    Badge: Badge.extend({ defaultProps: { tt: "none" } }),
  },
});

const HEADER_HEIGHT = 56;
const CHAT_WIDTH = 360;

/**
 * The number of live chat messages from others that came in while the chat was closed
 */
const useUnread = (open: boolean): number => {
  const { liveCount } = useAtomValue(chatAtom);
  const [seen, setSeen] = useState(liveCount);

  useEffect(() => {
    if (open) {
      setSeen(liveCount);
    }
  }, [open, liveCount]);

  return open ? 0 : liveCount - seen;
};

const Room = () => {
  const [chatOpen, chat] = useDisclosure(false);
  const [menuOpen, menu] = useDisclosure(false);
  const unread = useUnread(chatOpen);

  return (
    <AppShell
      header={{ height: HEADER_HEIGHT }}
      aside={{ width: CHAT_WIDTH, breakpoint: "sm", collapsed: { mobile: !chatOpen, desktop: !chatOpen } }}
      padding={0}
    >
      <AppShell.Header>
        <Toolbar chatOpen={chatOpen} unread={unread} onToggleChat={chat.toggle} onOpenMenu={menu.open} />
      </AppShell.Header>
      <AppShell.Main>
        <Stage />
      </AppShell.Main>
      {/* Always there, so that the log keeps its place while the panel is closed */}
      <AppShell.Aside>
        <ChatPanel onClose={chat.close} />
      </AppShell.Aside>
      <MenuDrawer opened={menuOpen} onClose={menu.close} />
      <PresentDialog />
      <EchoChoice />
      <CallAudio />
    </AppShell>
  );
};

const Page = ({ controller }: { controller: RoomController | null }) => {
  const unsupported = useAtomValue(unsupportedAtom);

  if (unsupported != null || controller == null) {
    return <Unsupported reason={unsupported ?? "webrtc"} />;
  }

  return (
    <ControllerContext value={controller}>
      <Room />
    </ControllerContext>
  );
};

/**
 * The page: the room, or what the browser lacks to join one
 */
export const App = ({ controller }: { controller: RoomController | null }) => (
  <MantineProvider theme={theme} forceColorScheme="dark">
    <Notifications position="bottom-center" />
    <Provider store={store}>
      <Page controller={controller} />
    </Provider>
  </MantineProvider>
);
