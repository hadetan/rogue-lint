import { internalCarrier, publicCarrier } from "./internal.js";

const internalResult = internalCarrier();
Number(internalResult.keep);

const publicResult = publicCarrier();
Number(publicResult.live);
