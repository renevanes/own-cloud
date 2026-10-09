/**
 * Koppelpunt tussen de app (HTTP, SMTP) en het cluster. Zonder cluster gedraagt alles zich als één losse server.
 */
export const runtime = {
  enabled: false,
  isLeader: (): boolean => true,
  /** Waar API-verzoeken heen moeten als deze node geen leider is (null = zelf afhandelen). */
  leaderApiUrl: (): string | null => null,
  apiServername: undefined as string | undefined,
  /** Wacht tot de laatste wijziging ook op een tweede data-node staat. */
  waitDurable: async (): Promise<boolean> => true,
  /** Inkomende mail tijdelijk opslaan op een niet-leider (secundaire MX). */
  spool: (_raw: Buffer): void => { throw new Error("Geen cluster"); },
  /** Cluster slaapt: inkomende mail tijdelijk weigeren (afzenders proberen het later opnieuw). */
  sleeping: (): boolean => false,
};
