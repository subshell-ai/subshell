import { Badge, Fact, FactCard } from "@internal/node-admin";
import type { AdminStatus } from "@/hooks/use-admin-status";

/**
 * Switches that are ON and should be noticed.
 *
 * Every row here is phrased so the ALARMING state is the loud one: this is the
 * page an admin skims, not one they read, and a posture item that renders
 * identically whether it is safe or not has told them nothing. The two
 * genuinely dangerous states — an armed break-glass password and a placeholder
 * auth secret — are the only warning badges.
 */
export function SecurityCard({ status }: { status: AdminStatus }) {
  const { security } = status;
  return (
    <FactCard title="Security posture">
      <Fact label="Registrations">
        <Badge variant={security.registrationsOpen ? "warning" : "muted"}>
          {security.registrationsOpen ? "open" : "closed"}
        </Badge>
      </Fact>
      <Fact label="Break-glass login">
        {security.emergencyLoginActive ? (
          <Badge
            variant="warning"
            title="SUBSHELL_EMERGENCY_PASSWORD is set. An admin signing in with it has their credential OVERWRITTEN. Clear the variable after recovery."
          >
            armed
          </Badge>
        ) : (
          <Badge variant="muted">off</Badge>
        )}
      </Fact>
      <Fact label="Auth secret">
        {security.usingPlaceholderSecret ? (
          <Badge
            variant="warning"
            title="BETTER_AUTH_SECRET is still the built-in placeholder. Production refuses to boot this way; set a real one before binding beyond loopback."
          >
            placeholder
          </Badge>
        ) : (
          <Badge variant="success">set</Badge>
        )}
      </Fact>
      <Fact label="System API keys" wide>
        {security.systemKeys.active} active
        <span className="text-muted-foreground">
          {" "}
          · {security.systemKeys.total} total. Each active key is a full-access bearer credential
        </span>
      </Fact>
    </FactCard>
  );
}
