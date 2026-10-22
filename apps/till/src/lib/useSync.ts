import { useSyncExternalStore } from "react";
import { syncStore } from "./sync.js";

export const useSyncStatus = () => useSyncExternalStore(syncStore.subscribe, syncStore.get);
