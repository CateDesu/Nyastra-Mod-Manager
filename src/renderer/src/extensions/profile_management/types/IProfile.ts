export interface IProfileMod {
  enabled: boolean;
  // Persisted millisecond timestamps. Each transition updates only its own field.
  enabledTime: number;
  disabledTime?: number;
}

export interface IProfile {
  id: string;
  gameId: string;
  name: string;
  modState: { [id: string]: IProfileMod };
  /** Cleared after Restore or Enable all succeeds. */
  enabledModsBeforeDisable?: string[];
  lastActivated: number;
  pendingRemove?: boolean;
  features?: { [featureId: string]: any };
}
