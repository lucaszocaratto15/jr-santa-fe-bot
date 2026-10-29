import type { VaultStore } from './vault';

export type TeachServices = { vault: VaultStore };

let services: TeachServices | null = null;

export const setTeachServices = (next: TeachServices | null): void => {
  services = next;
};

export const getTeachServices = (): TeachServices | null => services;
