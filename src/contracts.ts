export const CONTRACT_VERSION = 1;
export const PACKAGE_NAME = "@hasna/snapshots";
export const PACKAGE_VERSION = "0.1.1";

export interface ContractEnvelope {
  contract_version: typeof CONTRACT_VERSION;
}

export function withContract<T extends object>(value: T): T & ContractEnvelope {
  return {
    ...value,
    contract_version: CONTRACT_VERSION
  };
}
