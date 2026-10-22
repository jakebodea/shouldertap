import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Html,
  Preview,
  Section,
  Text,
  render,
  toPlainText,
} from "react-email";

/** Content only: all application mail inherits the same brand and text alternative. */
export interface EmailContent {
  subject: string;
  preview: string;
  heading: string;
  paragraphs: readonly string[];
  action?: { label: string; url: string };
  /** A one-time code, set large for reading and copying. */
  code?: string;
  note?: string;
  footer: string;
}

export const BrandedEmail = ({ content }: { content: EmailContent }) => (
  <Html lang="en">
    <Head>
      <title>{content.subject}</title>
    </Head>
    <Preview>{content.preview}</Preview>
    <Body
      style={{
        margin: 0,
        padding: "24px 12px",
        backgroundColor: "#ebe9e3",
        color: "#161616",
        fontFamily: "Arial, Helvetica, sans-serif",
      }}
    >
      <Container
        style={{
          maxWidth: 520,
          backgroundColor: "#2546db",
          borderRadius: 28,
          padding: "0 8px 8px",
        }}
      >
        <Text
          style={{
            margin: 0,
            padding: "28px 20px 24px",
            color: "#ffffff",
            fontSize: 26,
            fontWeight: 800,
            letterSpacing: -1,
          }}
        >
          Shouldertap
        </Text>
        <Section style={{ backgroundColor: "#f6f5f1", borderRadius: 22 }}>
          <Section style={{ padding: "36px 28px 40px" }}>
            <Heading
              style={{
                margin: "0 0 18px",
                fontSize: 36,
                lineHeight: "1.12",
                fontWeight: 800,
                letterSpacing: -1.3,
              }}
            >
              {content.heading}
            </Heading>
            {content.paragraphs.map((paragraph) => (
              <Text
                key={paragraph}
                style={{ margin: "0 0 28px", fontSize: 17, lineHeight: "1.55" }}
              >
                {paragraph}
              </Text>
            ))}
            {content.code && (
              <Text
                style={{
                  margin: 0,
                  padding: "18px 0",
                  borderRadius: 18,
                  backgroundColor: "#ebe9e3",
                  textAlign: "center",
                  fontSize: 40,
                  fontWeight: 800,
                  letterSpacing: 10,
                  fontFamily: "'SFMono-Regular', Menlo, Consolas, monospace",
                }}
              >
                {content.code}
              </Text>
            )}
            {content.action && (
              <Button
                href={content.action.url}
                style={{
                  padding: "16px 24px",
                  borderRadius: 999,
                  backgroundColor: "#161616",
                  color: "#ffffff",
                  fontSize: 16,
                  fontWeight: 700,
                  lineHeight: "20px",
                  textDecoration: "none",
                }}
              >
                {content.action.label}
              </Button>
            )}
            {content.note && (
              <Text
                style={{
                  margin: "20px 0 0",
                  fontSize: 14,
                  lineHeight: "1.5",
                  color: "#6f6e69",
                }}
              >
                {content.note}
              </Text>
            )}
          </Section>
          <Section
            style={{ padding: "24px 28px", borderTop: "1px solid #dedcd5" }}
          >
            <Text
              style={{
                margin: 0,
                fontSize: 14,
                lineHeight: "1.6",
                color: "#6f6e69",
              }}
            >
              {content.footer}
            </Text>
          </Section>
        </Section>
      </Container>
      <Text
        style={{
          margin: "20px 0 0",
          textAlign: "center",
          fontSize: 12,
          lineHeight: "1.5",
          color: "#6f6e69",
        }}
      >
        A small tap. A real connection.
      </Text>
    </Body>
  </Html>
);

export const renderEmail = async (content: EmailContent) => {
  if (content.action) {
    const url = new URL(content.action.url);
    if (
      url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      )
    ) {
      throw new Error(
        "Email actions must use HTTPS or local development URLs."
      );
    }
  }
  const html = await render(<BrandedEmail content={content} />);
  return { subject: content.subject, html, text: toPlainText(html) };
};
