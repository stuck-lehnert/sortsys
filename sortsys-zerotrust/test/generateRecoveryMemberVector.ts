import {
  base64,
  prepareRecovery,
  randomSecret,
  recoveredMembersFrame,
  recoveryMemberRegistrationFrame,
} from "../src/sortsys";
import { recoveryFixture } from "./support/recoveryFixture";

const fixture = await recoveryFixture();
let registrationProbe;
let registrationFrame;
const { plan } = await prepareRecovery({
  oldPhrase: fixture.phrase,
  newPhrase: fixture.newPhrase,
  password: fixture.password,
  source: fixture.source,
  register: async (input) => {
    if (input.member) {
      registrationProbe = input;
      registrationFrame = base64(
        recoveryMemberRegistrationFrame({
          tenant: input.tenant,
          challengeId: input.challengeId,
          account: {
            subject: input.subject,
            username: input.username,
            version: input.accountVersion!,
          },
          registrationRequest: input.registrationRequest,
        }),
      );
    }
    return fixture.register(input);
  },
  members: [
    {
      account: {
        subject: "user:member",
        username: "member",
        version: base64(randomSecret()),
      },
      password: "Public-synthetic-recovery-member-password",
    },
  ],
});
await Bun.write(
  new URL("./fixtures/recovery-member.json", import.meta.url),
  JSON.stringify(
    {
      notice:
        "Public synthetic recovery plan; no private identity keys or recovery phrases.",
      plan,
      membersFrame: await recoveredMembersFrame(plan.members!),
      registrationProbe,
      registrationFrame,
    },
    null,
    2,
  ) + "\n",
);
