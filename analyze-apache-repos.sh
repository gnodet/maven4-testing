#!/bin/bash

if [ -z "$1" ]; then
    echo "Usage: $0 YOUR_GITHUB_TOKEN"
    exit 1
fi

TOKEN="$1"
CURSOR="null"
HAS_NEXT_PAGE="true"

# Create temporary files for counting
COUNTS_FILE=$(mktemp)

# Initialize counts files
for letter in {A..Z}; do
    echo "$letter 0" >> "$COUNTS_FILE"
done

echo "Fetching Apache repositories..."
PAGE=1

# Main loop for pagination
while [ "$HAS_NEXT_PAGE" = "true" ]; do
    echo "Fetching page $PAGE..."
    
    if [ "$CURSOR" = "null" ]; then
        CURSOR_PART="null"
    else
        CURSOR_CLEAN=$(echo "$CURSOR" | sed 's/"//g')
        CURSOR_PART="\\\"$CURSOR_CLEAN\\\""
    fi
    
    # Extended GraphQL query to check for pom.xml (formatted as a single line)
    QUERY="{\"query\": \"query { organization(login: \\\"apache\\\") { repositories(first: 100, after: $CURSOR_PART) { pageInfo { hasNextPage endCursor } nodes { name primaryLanguage { name } defaultBranchRef { name target { ... on Commit { file(path: \\\"pom.xml\\\") { name } } } } } } } }\"}"

    # Make the API call
    RESPONSE=$(curl -s -H "Authorization: bearer $TOKEN" \
                    -H "Content-Type: application/json" \
                    -X POST \
                    -d "$QUERY" \
                    https://api.github.com/graphql)

    # Check if we got valid data
    if ! echo "$RESPONSE" | jq -e '.data.organization.repositories.nodes' > /dev/null; then
        echo "Error processing page $PAGE"
        echo "Query:"
        echo "$QUERY" | jq '.'
        echo "Response:"
        echo "$RESPONSE" | jq '.'
        break
    fi

    # Extract repos that are Java/Kotlin/Scala AND have pom.xml
    while read -r repo; do
        [ -z "$repo" ] && continue
        first_letter=$(echo "${repo:0:1}" | tr '[:lower:]' '[:upper:]')
        current_count=$(grep "^$first_letter " "$COUNTS_FILE" | awk '{print $2}')
        new_count=$((current_count + 1))
        sed -i.bak "s/^$first_letter .*/$first_letter $new_count/" "$COUNTS_FILE"
    done < <(echo "$RESPONSE" | jq -r '.data.organization.repositories.nodes[] | 
      select(.primaryLanguage != null) | 
      select(.primaryLanguage.name | test("Java|Kotlin|Scala")) |
      select(.defaultBranchRef.target.file != null) |
      .name')

    # Get counts for this page
    PAGE_COUNT=$(echo "$RESPONSE" | jq -r '.data.organization.repositories.nodes[] | 
      select(.primaryLanguage != null) | 
      select(.primaryLanguage.name | test("Java|Kotlin|Scala")) |
      select(.defaultBranchRef.target.file != null) |
      .name' | wc -l | tr -d ' ')
    echo "Found $PAGE_COUNT Java/Kotlin/Scala repositories with pom.xml on page $PAGE"

    # Also show skipped repos for verification
    SKIPPED_COUNT=$(echo "$RESPONSE" | jq -r '.data.organization.repositories.nodes[] | 
      select(.primaryLanguage != null) | 
      select(.primaryLanguage.name | test("Java|Kotlin|Scala")) |
      select(.defaultBranchRef.target.file == null) |
      .name' | wc -l | tr -d ' ')
    if [ "$SKIPPED_COUNT" -gt 0 ]; then
        echo "Skipped $SKIPPED_COUNT Java/Kotlin/Scala repos without pom.xml:"
        echo "$RESPONSE" | jq -r '.data.organization.repositories.nodes[] | 
          select(.primaryLanguage != null) | 
          select(.primaryLanguage.name | test("Java|Kotlin|Scala")) |
          select(.defaultBranchRef.target.file == null) |
          .name'
    fi

    # Update pagination info
    HAS_NEXT_PAGE=$(echo "$RESPONSE" | jq -r '.data.organization.repositories.pageInfo.hasNextPage')
    END_CURSOR=$(echo "$RESPONSE" | jq -r '.data.organization.repositories.pageInfo.endCursor')
    
    if [ "$HAS_NEXT_PAGE" = "true" ] && [ "$END_CURSOR" != "null" ]; then
        CURSOR="$END_CURSOR"
        PAGE=$((PAGE + 1))
    else
        break
    fi
done

echo -e "\nRepository counts by first letter (Java/Kotlin/Scala with pom.xml):"
sort "$COUNTS_FILE" | while read -r letter count; do
    [ "$count" -gt 0 ] && printf "%s: %d\n" "$letter" "$count"
done

# Calculate and show group counts
echo -e "\nGroup counts:"
echo "A-D: $(awk '/^[A-D]/ {sum += $2} END {print sum}' "$COUNTS_FILE")"
echo "E-H: $(awk '/^[E-H]/ {sum += $2} END {print sum}' "$COUNTS_FILE")"
echo "I-L: $(awk '/^[I-L]/ {sum += $2} END {print sum}' "$COUNTS_FILE")"
echo "M-P: $(awk '/^[M-P]/ {sum += $2} END {print sum}' "$COUNTS_FILE")"
echo "Q-T: $(awk '/^[Q-T]/ {sum += $2} END {print sum}' "$COUNTS_FILE")"
echo "U-Z: $(awk '/^[U-Z]/ {sum += $2} END {print sum}' "$COUNTS_FILE")"

# Show total
echo -e "\nAnalysis:"
TOTAL=$(awk '{sum += $2} END {print sum}' "$COUNTS_FILE")
echo "Total Java/Kotlin/Scala repositories with pom.xml: $TOTAL"

# Cleanup
rm -f "$COUNTS_FILE" "$COUNTS_FILE.bak"