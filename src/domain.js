export const actions=['created','corrected','revoked','restored'];
export const dispositions=['confirmed','deferred','rejected'];
export const validWeight=event=>Number.isFinite(event.grossKg)&&Number.isFinite(event.tareKg)&&event.grossKg>=event.tareKg;
