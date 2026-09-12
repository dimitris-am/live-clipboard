export function record(sql: SqlStorage, bucket: string, at: number): void {
  sql.exec("INSERT INTO rate_events (bucket, at) VALUES (?, ?)", bucket, at);
}

export function countSince(sql: SqlStorage, bucket: string, since: number): number {
  return sql
    .exec<{ n: number }>("SELECT COUNT(*) AS n FROM rate_events WHERE bucket = ? AND at > ?", bucket, since)
    .one().n;
}

export function oldestSince(sql: SqlStorage, bucket: string, since: number): number | null {
  return sql
    .exec<{ at: number | null }>("SELECT MIN(at) AS at FROM rate_events WHERE bucket = ? AND at > ?", bucket, since)
    .one().at;
}

export function pruneBefore(sql: SqlStorage, before: number): void {
  sql.exec("DELETE FROM rate_events WHERE at <= ?", before);
}
