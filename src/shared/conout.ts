/**
 * Copyright (c) 2020, Microsoft Corporation (MIT License).
 */

export interface IWorkerData {
  conoutPipeName: string;
  conoutFD?: number;
}

export const enum ConoutWorkerMessage {
  READY = 1
}

export function getWorkerPipeName(conoutPipeName: string): string {
  return `${conoutPipeName}-worker`;
}
