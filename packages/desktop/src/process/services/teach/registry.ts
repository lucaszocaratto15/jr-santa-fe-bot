import type { SecureInputBroker } from './control/secureInput';
import type { HandbookService } from './handbook/handbookService';
import type { LearnService } from './learn/learnService';
import type { Recorder } from './recording/recorder';
import type { TeachSession } from './recording/teachSession';
import type { VaultStore } from './vault/vault';

/** `recorder` is null when the CDP bridge is off: teach recording is then unavailable. */
export type TeachServices = { vault: VaultStore; recorder: Recorder | null };

let services: TeachServices | null = null;
let secureInput: SecureInputBroker | null = null;
let session: TeachSession | null = null;

export const setTeachServices = (next: TeachServices | null): void => {
  services = next;
};

export const getTeachServices = (): TeachServices | null => services;

/** Set once the teach control channel starts; the secure card IPC answers through it. */
export const setSecureInputBroker = (next: SecureInputBroker | null): void => {
  secureInput = next;
};

export const getSecureInputBroker = (): SecureInputBroker | null => secureInput;

/** Set with the control channel deps; the teach IPC and the draft tool go through it. */
export const setTeachSession = (next: TeachSession | null): void => {
  session = next;
};

export const getTeachSession = (): TeachSession | null => session;

let learn: LearnService | null = null;

/** "Aprender com seu trabalho": null on platforms without a sampler or before startup wires it. */
export const setLearnService = (next: LearnService | null): void => {
  learn = next;
};

export const getLearnService = (): LearnService | null => learn;

let handbook: HandbookService | null = null;

/** "Manual da função": null until startup wires it (desktop with a JR access controller). */
export const setHandbookService = (next: HandbookService | null): void => {
  handbook = next;
};

export const getHandbookService = (): HandbookService | null => handbook;
