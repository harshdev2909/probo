import type { TxLineSession } from "./session";
export interface ProofNode {
    hash: number[];
    isRightSibling: boolean;
}
export interface StatValidationInputV3 {
    ts: any;
    fixtureSummary: any;
    fixtureProof: ProofNode[];
    mainTreeProof: ProofNode[];
    eventStatRoot: number[];
    leaves: {
        stat: {
            key: number;
            value: number;
            period: number;
        };
        statProof: ProofNode[];
    }[];
    multiproofHashes: ProofNode[];
    leafIndices: number[];
}
/** The finalised sequence number for a fixture (statusId 100 = game_finalised). */
export declare function findFinalisedSeq(session: TxLineSession, fixtureId: number): Promise<number>;
/**
 * Fetch the raw v3 proof. `statKeys` order defines the leaf index space that your
 * predicates reference — keep it identical to your legs.
 */
export declare function fetchProofV3(session: TxLineSession, fixtureId: number, seq: number, statKeys: number[]): Promise<any>;
/** Shape a raw v3 response into the `validate_stat_v3` payload. */
export declare function toPayloadV3(val: any, BN: any): StatValidationInputV3;
/** The proven values, in leg order. */
export declare const provenValues: (val: any) => number[];
/** The epoch day whose root this proof authenticates against. */
export declare const proofEpochDay: (val: any) => number;
