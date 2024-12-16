#!/bin/bash

if [ -z "$1" ] || [ -z "$2" ]; then
    echo "Usage: $0 YOUR_GITHUB_TOKEN MAX_CHUNK_SIZE"
    echo "Example: $0 ghp_xxxx 200"
    exit 1
fi

TOKEN="$1"
MAX_CHUNK_SIZE="$2"
CURSOR="null"
HAS_NEXT_PAGE="true"
TEMP_REPOS_FILE=$(mktemp)

echo "Fetching Apache Maven repositories..."
PAGE=1

# First phase: gather all Maven repositories
while [ "$HAS_NEXT_PAGE" = "true" ]; do
    echo "Fetching page $PAGE..."
    
    if [ "$CURSOR" = "null" ]; then
        CURSOR_PART="null"
    else
        CURSOR_CLEAN=$(echo "$CURSOR" | sed 's/"//g')
        CURSOR_PART="\\\"$CURSOR_CLEAN\\\""
    fi
    
    QUERY="{\"query\": \"query { organization(login: \\\"apache\\\") { repositories(first: 100, after: $CURSOR_PART) { pageInfo { hasNextPage endCursor } nodes { name primaryLanguage { name } defaultBranchRef { name target { ... on Commit { file(path: \\\"pom.xml\\\") { name } } } } } } } }\"}"

    RESPONSE=$(curl -s -H "Authorization: bearer $TOKEN" \
                    -H "Content-Type: application/json" \
                    -X POST \
                    -d "$QUERY" \
                    https://api.github.com/graphql)

    # Extract Maven repositories and append to temp file
    echo "$RESPONSE" | jq -r '.data.organization.repositories.nodes[] | 
      select(.primaryLanguage != null) | 
      select(.primaryLanguage.name | test("Java|Kotlin|Scala")) |
      select(.defaultBranchRef.target.file != null) |
      .name' >> "$TEMP_REPOS_FILE"

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

# Sort repositories for consistent chunking
sort "$TEMP_REPOS_FILE" -o "$TEMP_REPOS_FILE"

# Count total repositories
TOTAL_REPOS=$(wc -l < "$TEMP_REPOS_FILE" | tr -d ' ')
echo "Found $TOTAL_REPOS Maven repositories"

# Calculate number of chunks needed
NUM_CHUNKS=$(( (TOTAL_REPOS + MAX_CHUNK_SIZE - 1) / MAX_CHUNK_SIZE ))
echo "Creating $NUM_CHUNKS chunks of maximum $MAX_CHUNK_SIZE repositories each"

# Create chunks directory
CHUNKS_DIR="maven4-chunks"
mkdir -p "$CHUNKS_DIR"

# Generate chunks as JSON files
chunk_num=1
chunk_size=$(( TOTAL_REPOS / NUM_CHUNKS ))
remaining=$((TOTAL_REPOS % NUM_CHUNKS))

start_line=1
while [ $chunk_num -le $NUM_CHUNKS ]; do
    # Calculate size for this chunk (distribute remaining lines)
    this_chunk_size=$chunk_size
    if [ $remaining -gt 0 ]; then
        this_chunk_size=$((chunk_size + 1))
        remaining=$((remaining - 1))
    fi
    
    # Extract repositories for this chunk
    end_line=$((start_line + this_chunk_size - 1))
    
    # Create JSON file for this chunk with fixed sed commands
    {
        echo "{"
        echo "  \"include\": ["
        sed -n "${start_line},${end_line}p" "$TEMP_REPOS_FILE" | \
            sed 's/^/    {"repository": "/' | \
            sed 's/$/"}/' | \
            sed '$!s/$/,/'
        echo "  ]"
        echo "}"
    } > "$CHUNKS_DIR/chunk-${chunk_num}.json"
    
    echo "Created chunk $chunk_num with $this_chunk_size repositories"
    start_line=$((end_line + 1))
    chunk_num=$((chunk_num + 1))
done

# Create a summary JSON file
{
    echo "{"
    echo "  \"total_repos\": $TOTAL_REPOS,"
    echo "  \"num_chunks\": $NUM_CHUNKS,"
    echo "  \"max_chunk_size\": $MAX_CHUNK_SIZE,"
    echo "  \"chunks\": ["
    for i in $(seq 1 $NUM_CHUNKS); do
        echo "    \"chunk-$i\""
        if [ $i -lt $NUM_CHUNKS ]; then
            echo -n ","
        fi
    done
    echo "  ]"
    echo "}"
} > "$CHUNKS_DIR/summary.json"

echo "Generated $NUM_CHUNKS chunks in $CHUNKS_DIR/"
echo "Summary file created at $CHUNKS_DIR/summary.json"

# Cleanup
rm -f "$TEMP_REPOS_FILE"