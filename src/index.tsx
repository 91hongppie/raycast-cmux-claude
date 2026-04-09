import {
  List,
  ActionPanel,
  Action,
  showToast,
  Toast,
  Icon,
  Color,
  closeMainWindow,
  popToRoot,
} from "@raycast/api";
import { useState, useEffect, useCallback, useRef } from "react";
import * as cmux from "./cmux";

interface Session {
  surfaceId: string;
  workspaceId: string;
  workspaceName: string;
  surfaceTitle: string;
  lastOutput: string;
  fullOutput: string;
  state: "idle" | "permission" | "busy";
}

export default function Command() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [commandText, setCommandText] = useState("");
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const isFirstLoad = useRef(true);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const results = await cmux.scanIdle();
      const newSessions = results.map(({ surface, lastOutput, fullOutput, state }) => ({
        surfaceId: surface.surfaceId,
        workspaceId: surface.workspaceId,
        workspaceName: surface.workspaceName || surface.workspaceId,
        surfaceTitle: surface.title,
        lastOutput,
        fullOutput,
        state: state!,
      }));

      if (isFirstLoad.current) {
        const order = { idle: 0, permission: 1, busy: 2 };
        newSessions.sort((a, b) => order[a.state] - order[b.state]);
        isFirstLoad.current = false;
        setSessions(newSessions);
      } else {
        // Preserve existing order, update data in place, append new sessions
        setSessions((prev) => {
          const updated = prev
            .map((s) => newSessions.find((n) => n.surfaceId === s.surfaceId))
            .filter((s): s is Session => s !== undefined);
          const existing = new Set(prev.map((s) => s.surfaceId));
          const added = newSessions.filter((n) => !existing.has(n.surfaceId));
          return [...updated, ...added];
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      showToast(Toast.Style.Failure, "Connection failed", msg);
    }
    setIsLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Auto-refresh only when not typing
  useEffect(() => {
    if (commandText.trim()) return;
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [refresh, commandText]);

  if (error && !isLoading) {
    return (
      <List>
        <List.EmptyView
          title="Connection Failed"
          description={error}
          icon={Icon.ExclamationMark}
          actions={
            <ActionPanel>
              <Action title="Retry" icon={Icon.ArrowClockwise} onAction={refresh} />
            </ActionPanel>
          }
        />
      </List>
    );
  }

  if (sessions.length === 0 && !isLoading) {
    return (
      <List>
        <List.EmptyView
          title="No Claude Sessions"
          description="No open Claude Code sessions found, or cmux is not running"
          icon={Icon.CheckCircle}
          actions={
            <ActionPanel>
              <Action
                title="New Session"
                icon={Icon.Plus}
                onAction={() => {
                  try {
                    cmux.newSession();
                    showToast(Toast.Style.Success, "New session started");
                    refresh();
                  } catch (err) {
                    showToast(Toast.Style.Failure, "Failed", String(err));
                  }
                }}
              />
              <Action title="Refresh" icon={Icon.ArrowClockwise} onAction={refresh} />
            </ActionPanel>
          }
        />
      </List>
    );
  }

  const showSkills = commandText.startsWith("/") && !commandText.includes(" ");
  const filteredSkills = showSkills
    ? getSkills().filter((s) => s.value && s.value.toLowerCase().startsWith(commandText.toLowerCase()))
    : [];

  // Auto-complete when exactly one skill matches and user typed enough (3+ chars)
  useEffect(() => {
    if (showSkills && filteredSkills.length === 1 && commandText.length >= 3) {
      const match = filteredSkills[0].value;
      if (match !== commandText) {
        setCommandText(match + " ");
      }
    }
  }, [commandText]);
  const skillsHint = filteredSkills.length > 0
    ? filteredSkills.map((s) => `\`${s.value}\`  ${s.title.includes("\u2014") ? s.title.split("\u2014")[1].trim() : ""}`).join("\n\n")
    : "";

  return (
    <List
      isLoading={isLoading}
      isShowingDetail
      filtering={false}
      searchBarPlaceholder="Type a command... (Enter to send, / for skills)"
      searchText={commandText}
      onSearchTextChange={setCommandText}
      selectedItemId={selectedId}
      onSelectionChange={(id) => setSelectedId(id ?? undefined)}
    >
      {sessions.map((session, index) => (
        <List.Item
          id={session.surfaceId}
          key={session.surfaceId}
          title={session.surfaceTitle || session.workspaceName}
          detail={
            <List.Item.Detail
              markdown={
                showSkills && skillsHint
                  ? `## Matching Skills\n\n${skillsHint}`
                  : `\`\`\`\n${session.fullOutput}\n\`\`\``
              }
            />
          }
          icon={{
            source:
              session.state === "permission"
                ? Icon.QuestionMark
                : session.state === "busy"
                  ? Icon.CircleProgress
                  : Icon.Terminal,
            tintColor:
              session.state === "permission"
                ? Color.Orange
                : session.state === "busy"
                  ? Color.Purple
                  : Color.Blue,
          }}
          accessories={[
            {
              tag: {
                value:
                  session.state === "permission"
                    ? "Permission"
                    : session.state === "busy"
                      ? "Working"
                      : "Idle",
                color:
                  session.state === "permission"
                    ? Color.Orange
                    : session.state === "busy"
                      ? Color.Purple
                      : Color.Green,
              },
            },
          ]}
          actions={
            <ActionPanel>
              {commandText.trim() && (
                <Action
                  title={`Send: ${commandText.trim().slice(0, 40)}`}
                  icon={Icon.ArrowRight}
                  onAction={async () => {
                    try {
                      cmux.sendText(session.surfaceId, session.workspaceId, commandText.trim());
                      showToast(Toast.Style.Success, "Sent", session.workspaceName);
                      setCommandText("");
                      refresh();
                    } catch (err) {
                      showToast(Toast.Style.Failure, "Send failed", String(err));
                    }
                  }}
                />
              )}
              {session.state === "permission" && (
                <>
                  <Action
                    title="Allow (y)"
                    icon={Icon.Check}
                    shortcut={{ modifiers: ["cmd"], key: "y" }}
                    onAction={async () => {
                      cmux.sendText(session.surfaceId, session.workspaceId, "y");
                      await showToast(Toast.Style.Success, "Allowed");
                      await closeMainWindow();
                      await popToRoot();
                    }}
                  />
                  <Action
                    title="Deny (n)"
                    icon={Icon.XMarkCircle}
                    shortcut={{ modifiers: ["cmd"], key: "d" }}
                    onAction={async () => {
                      cmux.sendText(session.surfaceId, session.workspaceId, "n");
                      await showToast(Toast.Style.Success, "Denied");
                      await closeMainWindow();
                      await popToRoot();
                    }}
                  />
                </>
              )}
              <Action
                title="Focus in cmux"
                icon={Icon.Eye}
                shortcut={{ modifiers: ["cmd"], key: "o" }}
                onAction={() => {
                  try {
                    cmux.focusSurface(session.surfaceId, session.workspaceId);
                    showToast(Toast.Style.Success, "Focused in cmux");
                  } catch (err) {
                    showToast(Toast.Style.Failure, "Focus failed", String(err));
                  }
                }}
              />
              <Action
                title="New Session"
                icon={Icon.Plus}
                shortcut={{ modifiers: ["cmd"], key: "n" }}
                onAction={() => {
                  try {
                    cmux.newSession();
                    showToast(Toast.Style.Success, "New session started");
                    refresh();
                  } catch (err) {
                    showToast(Toast.Style.Failure, "Failed", String(err));
                  }
                }}
              />
              <Action
                title="Refresh"
                icon={Icon.ArrowClockwise}
                shortcut={{ modifiers: ["cmd"], key: "r" }}
                onAction={refresh}
              />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}

// Skills are loaded dynamically from .claude/skills/ + built-in defaults
let _cachedSkills: cmux.SkillInfo[] | null = null;
function getSkills(): cmux.SkillInfo[] {
  if (!_cachedSkills) {
    try {
      _cachedSkills = cmux.scanSkills();
    } catch {
      _cachedSkills = [{ value: "", title: "(Type manually)" }];
    }
  }
  return _cachedSkills;
}

