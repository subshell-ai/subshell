export function DisplayMissingRequirements({ missing }: { missing: readonly string[] | undefined }) {
  if (!missing?.length) return null;
  return (
    <ul aria-label="Missing requirements on this node" className="list-disc pl-4 text-detail text-warning">
      {missing.map((requirement) => (
        <li key={requirement}>{requirement}</li>
      ))}
    </ul>
  );
}
