import { contextBridge, ipcRenderer } from "electron";

const invoke =
  (channel: string) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(channel, ...args);

const api = {
  listSessions: invoke("listSessions"),
  sessionCounts: invoke("sessionCounts"),
  createSession: invoke("createSession"),
  renameSession: invoke("renameSession"),
  deleteSession: invoke("deleteSession"),
  clearSession: invoke("clearSession"),

  listSolves: invoke("listSolves"),
  addSolve: invoke("addSolve"),
  updateSolve: invoke("updateSolve"),
  deleteSolve: invoke("deleteSolve"),

  getScrambleState: invoke("getScrambleState"),
  setScrambleState: invoke("setScrambleState"),

  getSettings: invoke("getSettings"),
  setSettings: invoke("setSettings"),

  listUserBackgrounds: invoke("listUserBackgrounds"),
  addUserBackground: invoke("addUserBackground"),
  deleteUserBackground: invoke("deleteUserBackground"),

  exportToFile: invoke("exportToFile"),
};

contextBridge.exposeInMainWorld("api", api);
