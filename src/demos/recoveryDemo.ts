import { buildReservationApp } from '../app';
import { sampleRequest } from '../support/sampleData';
import { printMessageLog, printRefundState } from './state';

const app = buildReservationApp();
app.gateway.failOnCall(1); // the first provider call throws

const booking = app.service.book(sampleRequest({ start: 11 * 60, end: 13 * 60 }));
const cancellation = app.service.cancel(booking.id);
printRefundState(app, 'after the failed delivery');

// The provider is back (only call 1 was armed), so redeliver the dead-lettered message.
app.bus.redeliver(cancellation.refundMessageId as string);
printRefundState(app, 'after redelivery');
printMessageLog(app);