export const actions=['created','corrected','revoked','restored'];
export const dispositions=['confirmed','deferred','rejected'];
export const weightBearingActions=['created','corrected','restored'];
export const validWeight=event=>Number.isFinite(event.grossKg)&&Number.isFinite(event.tareKg)&&event.grossKg>=event.tareKg;
export const netKgOf=event=>event.grossKg-event.tareKg;
