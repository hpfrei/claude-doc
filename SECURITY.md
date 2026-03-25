# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in claude-doc, please report it responsibly through GitHub's private vulnerability reporting:

1. Go to the [Security tab](https://github.com/hpfrei/claude-doc/security) of this repository
2. Click **Report a vulnerability**
3. Provide a description of the issue and steps to reproduce

Please do **not** open a public issue for security vulnerabilities.

I will review reports promptly and work with you on a fix before any public disclosure.

## Scope

claude-doc is a local development tool that proxies API traffic. Key areas of concern include:

- Exposure of API keys or credentials through the proxy or dashboard
- Unauthorized access to the dashboard or proxy endpoints
- Code injection via crafted prompts or API responses

## Best Practices

When running claude-doc, keep in mind:

- The proxy and dashboard bind to `localhost` by default — avoid exposing them to untrusted networks without additional authentication
- API keys are forwarded to the Anthropic API but are never logged or persisted by claude-doc
- Interaction logs saved to disk may contain sensitive data from your prompts and responses
