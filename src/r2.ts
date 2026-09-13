/** Deletes every object under a prefix, 1,000 keys per call. Throws if R2 fails. */
export async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<void> {
  for (;;) {
    const page = await bucket.list({ prefix, limit: 1000 });
    if (page.objects.length === 0) return;
    await bucket.delete(page.objects.map((object) => object.key));
    if (!page.truncated) return;
  }
}
