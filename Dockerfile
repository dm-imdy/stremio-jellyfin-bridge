# Use Node 22 (Alpine is a highly compressed, secure OS)
FROM node:22-alpine

# Install tzdata so the container can process timezones
RUN apk add --no-cache tzdata

# Set the working directory inside the container
WORKDIR /app

# Copy package files AND the patches folder first
COPY package*.json ./
COPY patches/ ./patches/

# Install dependencies (only production ones)
RUN npm install --omit=dev

# Copy the rest of the addon code
COPY . .

# Start the server
CMD ["npm", "start"]
