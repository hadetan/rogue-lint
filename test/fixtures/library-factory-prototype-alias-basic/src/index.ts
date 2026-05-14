class DayLike {
  format(): string {
    return "ok";
  }

  chain(): DayLike {
    return this;
  }
}

class InternalOnly {
  stale(): string {
    return "stale";
  }
}

type DayFactory = (() => DayLike) & { prototype: DayLike };

const day = (() => new DayLike()) as DayFactory;
const proto = DayLike.prototype;
day.prototype = proto;

const internalProto = InternalOnly.prototype;
const internalFactory = (() => new InternalOnly()) as (() => InternalOnly) & { prototype: InternalOnly };
internalFactory.prototype = internalProto;

export default day;
