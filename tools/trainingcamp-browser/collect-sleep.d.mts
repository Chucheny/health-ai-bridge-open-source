export function collectSleepInPage(request: { startDay: string; endDay: string }): Promise<unknown>;
export function collectTrainingCampInPage(request: { kind: 'sleep' | 'activity'; startDay: string; endDay: string }): Promise<unknown>;
