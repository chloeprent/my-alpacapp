-- Add work_checkout_summary email template
-- Sent to associate + team@alpacaplayhouse.com on clock-out with session details + photos

INSERT INTO email_templates (template_key, category, description, sender_type, subject_template, html_template, text_template, placeholders)
VALUES (
  'work_checkout_summary',
  'system',
  'Sent to associate and admin after clocking out — includes session details and work photos',
  'team',
  'Work Session Summary — {{first_name}} ({{date}})',
  $html$
<h2 style="margin:0 0 4px;">Work Session Complete</h2>
<p style="margin:0 0 20px;color:#7d6f74;font-size:14px;">{{first_name}} has clocked out.</p>

<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f2f0e8;border:1px solid #e6e2d9;border-radius:8px;margin:0 0 20px;">
  <tr>
    <td style="padding:20px 24px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr>
          <td style="padding:0 0 8px;"><strong>Date:</strong></td>
          <td style="padding:0 0 8px;text-align:right;">{{date}}</td>
        </tr>
        <tr>
          <td style="padding:0 0 8px;"><strong>Clock In:</strong></td>
          <td style="padding:0 0 8px;text-align:right;">{{clock_in_time}}</td>
        </tr>
        <tr>
          <td style="padding:0 0 8px;"><strong>Clock Out:</strong></td>
          <td style="padding:0 0 8px;text-align:right;">{{clock_out_time}}</td>
        </tr>
        <tr>
          <td style="padding:0 0 8px;"><strong>Duration:</strong></td>
          <td style="padding:0 0 8px;text-align:right;">{{duration}}</td>
        </tr>
        {{#if space_name}}
        <tr>
          <td style="padding:0 0 8px;"><strong>Location:</strong></td>
          <td style="padding:0 0 8px;text-align:right;">{{space_name}}</td>
        </tr>
        {{/if}}
        {{#if task_name}}
        <tr>
          <td style="padding:0 0 8px;"><strong>Task:</strong></td>
          <td style="padding:0 0 8px;text-align:right;">{{task_name}}</td>
        </tr>
        {{/if}}
        <tr>
          <td style="padding:0;border-top:1px solid #e6e2d9;padding-top:8px;"><strong>Earnings:</strong></td>
          <td style="padding:0;border-top:1px solid #e6e2d9;padding-top:8px;text-align:right;font-weight:600;color:#d4883a;">{{earnings}} <span style="font-weight:400;color:#7d6f74;font-size:13px;">@ ${{hourly_rate}}/hr</span></td>
        </tr>
      </table>
    </td>
  </tr>
</table>

{{#if description}}
<p style="margin:0 0 4px;font-weight:600;font-size:14px;">Work Description</p>
<p style="margin:0 0 20px;color:#2a1f23;">{{description}}</p>
{{/if}}

<p style="margin:16px 0 0;color:#7d6f74;font-size:13px;">This is an automated summary from Alpaca Playhouse work tracking.</p>
$html$,
  $text$Work Session Complete

{{first_name}} has clocked out.

Date: {{date}}
Clock In: {{clock_in_time}}
Clock Out: {{clock_out_time}}
Duration: {{duration}}
{{#if space_name}}Location: {{space_name}}
{{/if}}{{#if task_name}}Task: {{task_name}}
{{/if}}Earnings: {{earnings}} @ ${{hourly_rate}}/hr
{{#if description}}
Work Description: {{description}}
{{/if}}

This is an automated summary from Alpaca Playhouse work tracking.$text$,
  '[{"key":"first_name","required":true,"description":"Associate first name"},{"key":"date","required":true,"description":"Work date"},{"key":"clock_in_time","required":true,"description":"Clock in time"},{"key":"clock_out_time","required":true,"description":"Clock out time"},{"key":"duration","required":true,"description":"Session duration"},{"key":"space_name","required":false,"description":"Location/space name"},{"key":"task_name","required":false,"description":"Task name"},{"key":"description","required":false,"description":"Work description"},{"key":"hourly_rate","required":true,"description":"Hourly rate"},{"key":"earnings","required":true,"description":"Formatted earnings amount"},{"key":"photos","required":false,"description":"Array of work photos (rendered in hardcoded fallback only)"}]'::jsonb
)
ON CONFLICT (template_key, version) DO UPDATE SET
  html_template = EXCLUDED.html_template,
  text_template = EXCLUDED.text_template,
  subject_template = EXCLUDED.subject_template,
  description = EXCLUDED.description,
  placeholders = EXCLUDED.placeholders,
  updated_at = now();
