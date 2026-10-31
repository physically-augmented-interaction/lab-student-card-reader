// Restrict the outer lookup to this session; the second index lookup checks
// whether a more recent event exists without aggregating the entire history.
export const LIST_PRESENT_SQL = `
  SELECT v.student_id, v.event_type, v.occurred_at,
         COALESCE(m.display_name, '') AS display_name
  FROM visits v
  LEFT JOIN members m ON m.student_id = v.student_id
  WHERE v.occurred_at >= ?
    AND NOT EXISTS (
      SELECT 1
      FROM visits newer
      WHERE newer.student_id = v.student_id
        AND newer.occurred_at > v.occurred_at
    )
  ORDER BY v.occurred_at DESC
`;
