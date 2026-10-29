import type { SecureInputBroker } from './control/secureInput';
import type { VaultStore } from './vault/vault';

export type TeachServices = { vault: VaultStore };

let services: TeachServices | null = null;
let secureInput: SecureInputBroker | null = null;

export const setTeachServices = (next: TeachServices | null): void => {
  services = next;
};

export const getTeachServices = (): TeachServices | null => services;

/** Set once the teach control channel starts; the secure card IPC answers through it. */
export const setSecureInputBroker = (next: SecureInputBroker | null): void => {
  secureInput = next;
};

export const getSecureInputBroker = (): SecureInputBroker | null => secureInput;
