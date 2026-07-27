import type {
  EventId,
  NewSolve,
  Penalty,
  ScrambleState,
  Session,
  Settings,
  Solve,
  UserBackground,
} from "../shared/types.js";

declare global {
  interface Window {
    api: {
      listSessions(): Promise<Session[]>;
      sessionCounts(): Promise<Record<number, number>>;
      createSession(name: string, eventId: EventId): Promise<Session>;
      renameSession(id: number, name: string): Promise<void>;
      deleteSession(id: number): Promise<void>;
      clearSession(id: number): Promise<void>;

      listSolves(sessionId: number): Promise<Solve[]>;
      addSolve(s: NewSolve): Promise<Solve>;
      updateSolve(id: number, patch: { penalty?: Penalty; comment?: string }): Promise<void>;
      deleteSolve(id: number): Promise<void>;

      getScrambleState(sessionId: number): Promise<ScrambleState>;
      setScrambleState(sessionId: number, state: ScrambleState): Promise<ScrambleState>;

      getSettings(): Promise<Settings>;
      setSettings(patch: Partial<Settings>): Promise<Settings>;

      listUserBackgrounds(): Promise<UserBackground[]>;
      addUserBackground(): Promise<UserBackground | null>;
      deleteUserBackground(id: string): Promise<boolean>;

      exportToFile(): Promise<string | null>;
    };
  }
}

export {};
